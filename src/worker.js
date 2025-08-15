import { budget, salt } from "./config.js";
import * as jose from "jose";
import { providers, sseTransform } from "./providers.js";
import { updateHeaders, addCors, createToken } from "./utils.js";
export { AIPipeCost } from "./cost.js";

const SKIP_REQUEST_HEADERS = [/^content-length$/i, /^host$/i, /^cf-.*$/i, /^connection$/i, /^accept-encoding$/i];
const SKIP_RESPONSE_HEADERS = [/^transfer-encoding$/i, /^connection$/i, /^content-security-policy$/i];

export default {
  async fetch(request, env) {
    // If the request is a preflight request, return early
    if (request.method == "OPTIONS")
      return new Response(null, { headers: addCors(new Headers({ "Access-Control-Max-Age": "86400" })) });

    // We use providers to handle different LLMs.
    // The provider is the first part of the path between /.../ -- e.g. /openai/
    const url = new URL(request.url);
    const provider = url.pathname.split("/")[1];

    // If token was requested, verify user and share token
    if (provider == "token") return await tokenFromCredential(url.searchParams.get("credential"), env.AIPIPE_SECRET);

    // Check if the URL matches a valid provider. Else let the user know
    if (!providers[provider] && provider != "usage" && provider != "admin" && provider != "proxy")
      return jsonResponse({ code: 404, message: `Unknown provider: ${provider}` });

    if (provider === "proxy") return proxyRequest(request);

    // Token must be present in Authorization: Bearer
    const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s*/, "").trim();
    if (!token) return jsonResponse({ code: 401, message: "Missing Authorization: Bearer token" });

    // Token must contain a valid JWT payload
    const payload = await validateToken(token, env.AIPIPE_SECRET);
    if (payload.error) return jsonResponse({ code: 401, message: payload.error });

    // Get the email and domain
    const email = payload.email;
    const domain = "@" + email.split("@").at(-1);
    // Get user's budget limit and time period based on email || domain || default (*) || zero limit
    const { limit, days } = budget[payload.email] ?? budget[domain] ?? budget["*"] ?? { limit: 0, days: 1 };

    // Get the SQLite database with cost data
    const aiPipeCostId = env.AIPIPE_COST.idFromName("default");
    const aiPipeCost = env.AIPIPE_COST.get(aiPipeCostId);

    // If usage data was requested, share usage and limit data
    if (provider == "usage") return jsonResponse({ code: 200, ...(await aiPipeCost.usage(email, days)), limit });

    // Handle admin endpoints
    if (provider == "admin") {
      const admins = (env.ADMIN_EMAILS || "").split(/[,\s]+/);
      if (!admins.includes(payload.email)) return jsonResponse({ code: 403, message: "Admin access required" });

      const action = url.pathname.split("/")[2];
      if (action == "usage") return jsonResponse({ code: 200, data: await aiPipeCost.allUsage() });
      if (action == "token") {
        const email = url.searchParams.get("email") ?? payload.email;
        const token = await createToken(email, env.AIPIPE_SECRET, salt[email] ? { salt: salt[email] } : {});
        return jsonResponse({ code: 200, token });
      }
      if (action == "cost") {
        if (request.method !== "POST") return jsonResponse({ code: 405, message: "Use POST /admin/cost" });
        const { email, date, cost } = await request.json();
        await aiPipeCost.setCost(email, date, cost);
        return jsonResponse({ code: 200, message: `Cost for ${email} on ${date} set to ${cost}` });
      }
      return jsonResponse({ code: 404, message: "Unknown admin action" });
    }

    // Reject if user's cost usage is at limit
    const usage = await aiPipeCost.cost(email, days);
    if (usage >= limit) return jsonResponse({ code: 429, message: `Usage $${usage} / $${limit} in ${days} days` });

    // Allow providers to transform or reject
    const path = url.pathname.slice(provider.length + 1) + url.search;
    const {
      url: targetUrl,
      headers,
      error,
      model: tModel,
      usage: tUsage,
      ...params
    } = await providers[provider].transform({ path, request, env });
    if (error) return jsonResponse(error);

    // For similarity provider, return the result directly
    if (provider === "similarity" && params.similarity) {
      const { cost } = await providers[provider].cost({ model: params.model, usage: params.usage });
      if (cost > 0) await aiPipeCost.add(email, cost);
      return jsonResponse({ code: 200, ...params });
    }
    // Make the actual request
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: updateHeaders(headers, SKIP_REQUEST_HEADERS),
      ...params,
    });

    // Add the cost based on provider's cost
    const parse = providers[provider].parse;
    const addCost = async (data) => {
      const parsed = parse ? parse(data) : {};
      const model = parsed.model ?? tModel;
      const usage = parsed.usage ?? tUsage;
      const { cost } = await providers[provider].cost({ model, usage });
      if (cost > 0) await aiPipeCost.add(email, cost);
    };

    // For JSON response, extract { model, usage } and add cost based on that
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) await addCost(await response.clone().json());

    // For streaming response, extract { model, usage } wherever it appears
    const body = contentType.includes("text/event-stream")
      ? response.body.pipeThrough(sseTransform(provider, addCost))
      : response.body;
    // TODO: If the response is not JSON or SSE (e.g. image), handle cost.

    return new Response(body, {
      headers: addCors(updateHeaders(response.headers, SKIP_RESPONSE_HEADERS)),
      status: response.status,
      statusText: response.statusText,
    });
  },
};

function jsonResponse({ code, ...rest }) {
  return new Response(JSON.stringify(rest, null, 2), {
    status: code,
    headers: addCors(new Headers({ "Content-Type": "application/json" })),
  });
}

async function proxyRequest(request) {
  const targetUrl = request.url.split("/proxy/")[1];
  if (!targetUrl.startsWith("http")) return jsonResponse({ code: 400, message: "URL must begin with http" });

  // abort stalled fetches so workers don't hang
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  // mirror the request while stripping unsafe headers
  const safeRequest = {
    method: request.method,
    headers: updateHeaders(request.headers, SKIP_REQUEST_HEADERS),
    redirect: "follow",
    signal: controller.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") safeRequest.body = request.body;

  let response;
  try {
    response = await fetch(targetUrl, safeRequest);
  } catch (error) {
    clearTimeout(timeoutId);
    return jsonResponse(
      error.name === "AbortError"
        ? { code: 504, message: "Request timed out after 30 seconds" }
        : { code: 500, message: `Proxy error: ${error.name} - ${error.message}` },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // return the upstream response with cors and stripped headers
  return new Response(response.body, {
    headers: addCors(updateHeaders(response.headers, SKIP_RESPONSE_HEADERS, { "X-Proxy-URL": targetUrl })),
    status: response.status,
    statusText: response.statusText,
  });
}

async function validateToken(token, secret) {
  // Verify the token using the secret. If it's invalid, report an error
  let payload;
  const secretBytes = new TextEncoder().encode(secret);
  try {
    payload = (await jose.jwtVerify(token, secretBytes)).payload;
  } catch (err) {
    return { error: `Bearer ${token} is invalid: ${err}` };
  }
  if (salt[payload.email] && salt[payload.email] != payload.salt)
    return { error: `Bearer ${token} is no longer valid` };
  return payload;
}

// Return { token } given valid Google credentials
async function tokenFromCredential(credential, secret) {
  const JWKS = jose.createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  const { payload } = await jose.jwtVerify(credential, JWKS, {
    issuer: "https://accounts.google.com",
    audience: "1098061226510-1gn6mjnpdi30jiehanff71ri0ejva0t7.apps.googleusercontent.com",
  });
  if (!payload.email_verified) return jsonResponse({ code: 401, message: "Invalid Google credentials" });

  const params = { email: payload.email };
  if (salt[payload.email]) params.salt = salt[payload.email];
  const token = await new jose.SignJWT(params)
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(secret));
  return jsonResponse({ code: 200, token, ...payload });
}
