import t from "tap";
import { readFileSync } from "fs";
import { Agent } from "undici";
import { salt } from "../src/config.js";
import { createToken, ymd } from "../src/utils.js";

// Get base URL environment or default to localhost:8787
const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const AIPIPE_SECRET = readFileSync(".dev.vars", "utf8")
  .split("\n")
  .find((l) => l.startsWith("AIPIPE_SECRET="))
  .split("=")[1];

const testToken = (email = "test@example.com", salt) => createToken(email, AIPIPE_SECRET, { salt });

// Use the first admin email specified in the environment
const adminEmail = (process.env.ADMIN_EMAILS || "admin@example.com").split(/[,\s]+/).at(0);

async function fetch(path, { headers, ...params } = {}) {
  const url = `${BASE_URL}${path}`;
  const defaultHeaders = path.startsWith("/proxy/") ? {} : { "Content-Type": "application/json" };
  return await globalThis.fetch(url, { headers: { ...defaultHeaders, ...headers }, ...params });
}

async function getUsage(token) {
  return await fetch("/usage", { headers: { Authorization: `Bearer ${token}` } }).then((res) => res.json());
}

t.test("CORS headers", async (t) => {
  const res = await fetch("/openrouter/v1/models", { method: "OPTIONS" });
  t.equal(res.status, 200);
  t.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  t.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, POST");
  t.equal(res.headers.get("Access-Control-Max-Age"), "86400");
});

t.test("Authorization required", async (t) => {
  const res = await fetch("/openrouter/v1/models");
  t.equal(res.status, 401);
  const body = await res.json();
  t.match(body.message, /Missing Authorization/);
});

t.test("Invalid JWT token", async (t) => {
  const res = await fetch("/openrouter/v1/models", {
    headers: { Authorization: "Bearer invalid-token" },
  });
  t.equal(res.status, 401);
  const body = await res.json();
  t.match(body.message, /invalid/i);
});

t.test("Valid JWT token", async (t) => {
  const token = await testToken();
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.not(res.status, 401);
});

t.test("Invalid provider", async (t) => {
  const token = await testToken();
  const res = await fetch("/invalid-provider/", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 404);
  const body = await res.json();
  t.match(body.message, /Unknown provider/);
});

t.test("Invalid salt", async (t) => {
  const token = await testToken(Object.keys(salt)[0]);
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 401);
  const body = await res.json();
  t.match(body.message, /no longer valid/);
});

t.test("Valid salt", async (t) => {
  const token = await testToken(...Object.entries(salt)[0]);
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 200);
  const body = await res.json();
  t.ok(body.data.length);
});

t.test("Usage endpoint", async (t) => {
  const token = await testToken();
  const usage = await getUsage(token);
  t.type(usage.limit, "number");
  t.type(usage.days, "number");
  t.type(usage.cost, "number");
  t.ok(Array.isArray(usage.usage));
});

t.test("Completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "google/gemini-2.5-flash-lite";
  const res = await fetch("/openrouter/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "What is 2 + 2?" }] }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.id, /^gen-/);
  t.match(body.model, model);

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Embedding and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "text-embedding-3-small";
  const res = await fetch("/openai/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, input: "What is 2 + 2?" }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.object, "list");
  t.match(body.model, model);

  const usageEnd = await getUsage(token);
  // Cost should be 8 Tok * $0.02 / MTok
  t.ok(Math.abs(usageEnd.cost - usageStart.cost - 1.6e-7) < 1e-12);
});

t.test("Streaming completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "google/gemini-2.5-flash-lite";
  const res = await fetch("/openrouter/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "What is 2 + 2?" }], stream: true }),
  });
  t.equal(res.status, 200);
  t.equal(res.headers.get("Content-Type").split(";")[0], "text/event-stream");

  await res.text();
  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("OpenAI completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "gpt-4.1-nano";
  const res = await fetch("/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "What is 2 + 2?" }] }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.object, "chat.completion");

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("OpenAI responses streaming completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "gpt-4.1-nano";
  const res = await fetch("/openai/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, input: "What is 2 + 2?", stream: true }),
  });
  t.equal(res.status, 200);
  t.equal(res.headers.get("Content-Type").split(";")[0], "text/event-stream");

  await res.text();
  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Gemini completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const res = await fetch("/geminiv1beta/models/gemini-2.5-flash-lite:generateContent", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ contents: [{ parts: [{ text: "What is 2 + 2?" }] }] }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.ok(Array.isArray(body.candidates));

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Gemini streaming completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const res = await fetch("/geminiv1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ contents: [{ parts: [{ text: "What is 2 + 2?" }] }] }),
  });
  t.equal(res.status, 200);
  t.equal(res.headers.get("Content-Type").split(";")[0], "text/event-stream");

  await res.text();
  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Gemini embedding and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const res = await fetch("/geminiv1beta/models/gemini-embedding-001:embedContent", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "gemini-embedding-001", content: { parts: [{ text: "What is 2 + 2?" }] } }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.ok(body.embedding);

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Similarity API", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const res = await fetch("/similarity", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      docs: ["The quick brown fox jumps over the lazy dog"],
      topics: ["fox jumping", "dog sleeping"],
      model: "text-embedding-3-small",
    }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.model, "text-embedding-3-small");
  t.ok(Array.isArray(body.similarity));
  t.equal(body.similarity.length, 1);
  t.equal(body.similarity[0].length, 2);

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Budget limit exceeded", async (t) => {
  // This test assumes the user has already exceeded their budget
  const token = await testToken("blocked@example.com");
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 429);
  const body = await res.json();
  t.match(body.message, /\$0 in 1 days/);
});

t.test("Admin: unauthorized access", async (t) => {
  const token = await testToken();
  const res = await fetch("/admin/usage", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 403);
  const body = await res.json();
  t.match(body.message, /Admin access required/);
});

t.test("Admin: usage data", async (t) => {
  const token = await testToken(adminEmail);
  const res = await fetch("/admin/usage", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 200);
  const body = await res.json();
  t.ok(Array.isArray(body.data));
  t.type(body.data[0]?.email, "string");
  t.type(body.data[0]?.date, "string");
  t.type(body.data[0]?.cost, "number");
});

t.test("Admin: token generation", async (t) => {
  const token = await testToken(adminEmail);
  const res = await fetch("/admin/token?email=user@example.com", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 200);
  const body = await res.json();
  t.type(body.token, "string");
  const models = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${body.token}` } });
  t.equal(models.status, 200);
});

t.test("Admin: invalid endpoint", async (t) => {
  const token = await testToken(adminEmail);
  const res = await fetch("/admin/invalid", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 404);
  const body = await res.json();
  t.match(body.message, /Unknown admin action/);
});

t.test("Admin: set cost", async (t) => {
  const email = "test@example.com";
  const date = ymd(new Date());
  const token = await testToken(email);
  const adminToken = await testToken(adminEmail);

  // Get the usage of email for date (0 if missing)
  const usageStart = await getUsage(token);
  const originalCost = usageStart.usage.find((row) => row.date === date)?.cost ?? 0;

  // Add/subtract 1 micro-dollar based on timestamp
  const cost = originalCost + (Date.now() % 2 ? 0.000001 : -0.000001);
  await fetch("/admin/cost", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ email, date, cost }),
  });

  // Get the cost and verify it's within acceptable floating point error (1e-12)
  const usageEnd = await getUsage(token);
  const actualCost = usageEnd.usage.find((row) => row.date === date)?.cost ?? 0;
  t.ok(Math.abs(actualCost - cost) < 1e-12);
});

t.test("Proxy API", async (t) => {
  // Test successful request
  const res1 = await fetch("/proxy/https://httpbin.org/get?x=1");
  t.equal(res1.status, 200);
  const body1 = await res1.json();
  t.equal(body1.args.x, "1");
  t.equal(res1.headers.get("X-Proxy-URL"), "https://httpbin.org/get?x=1");

  // Test invalid URL
  const res2 = await fetch("/proxy/ftp://example.com");
  t.equal(res2.status, 400);
  const body2 = await res2.json();
  t.match(body2.message, /URL must begin with http/);

  // Test request method and headers preservation
  const res4 = await fetch("/proxy/https://httpbin.org/post", {
    method: "POST",
    headers: {
      "X-Custom-Header": "test-value",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ test: true }),
  });
  t.equal(res4.status, 200);
  const body4 = await res4.json();
  t.equal(body4.headers["X-Custom-Header"], "test-value");
  t.equal(body4.headers["Content-Type"], "application/json");
  t.equal(body4.json.test, true);

  // Test response headers stripping
  const res6 = await fetch("/proxy/https://httpbin.org/response-headers", {
    method: "GET",
    headers: {
      "X-Response-Headers":
        "connection,content-encoding,content-length,host,transfer-encoding,content-security-policy,access-control-allow-headers,access-control-allow-methods,access-control-allow-origin,access-control-expose-headers",
      Connection: "close",
      Host: "example.com",
      "Content-Security-Policy": "default-src 'self'",
      "Access-Control-Allow-Headers": "custom",
      "Access-Control-Allow-Methods": "PUT",
      "Access-Control-Allow-Origin": "https://example.com",
      "Access-Control-Expose-Headers": "custom",
    },
  });
  t.equal(res6.status, 200);

  // Verify that our CORS headers are set
  t.equal(res6.headers.get("Access-Control-Allow-Origin"), "*");
  t.equal(res6.headers.get("Access-Control-Allow-Methods"), "GET, POST");
  t.equal(res6.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type");
  t.equal(res6.headers.get("Access-Control-Expose-Headers"), "*");

  // Verify that the original headers are stripped
  const body6 = await res6.json();

  // Check that none of our test headers are in the response
  const testHeaders = [
    "connection",
    "host",
    "content-security-policy",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "access-control-expose-headers",
  ];

  for (const header of testHeaders) t.notOk(body6[header], `Header ${header} should be stripped`);

  // Test comprehensive header stripping
  const res7 = await fetch("/proxy/https://httpbin.org/response-headers", {
    method: "GET",
    headers: {
      // Request headers to skip (only testing ones we can safely set)
      Origin: "https://example.com",

      // Response headers to strip (only testing ones we can safely set)
      "Content-Encoding": "gzip",
      "Content-Length": "123",

      // OpenRouter security headers
      "Content-Security-Policy": "default-src 'self'",
      "Access-Control-Allow-Headers": "custom",
      "Access-Control-Allow-Methods": "PUT",
      "Access-Control-Allow-Origin": "https://example.com",
      "Access-Control-Expose-Headers": "custom",

      // Tell httpbin to echo these headers
      "X-Response-Headers":
        "origin,content-encoding,content-length,content-security-policy,access-control-allow-headers,access-control-allow-methods,access-control-allow-origin,access-control-expose-headers",
    },
  });

  t.equal(res7.status, 200);
  const body7 = await res7.json();
  console.log("Comprehensive test response:", JSON.stringify(body7, null, 2));

  // Verify all headers are stripped
  const allHeaders = [
    // Request headers (only testing ones we can safely set)
    "origin",
    // Response headers (only testing ones we can safely set)
    "content-encoding",
    "content-length",
    // Security headers
    "content-security-policy",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "access-control-expose-headers",
  ];

  for (const header of allHeaders) t.notOk(body7[header], `Header ${header} should be stripped`);

  // Verify CORS headers are set
  t.equal(res7.headers.get("Access-Control-Allow-Origin"), "*");
  t.equal(res7.headers.get("Access-Control-Allow-Methods"), "GET, POST");
  t.equal(res7.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type");
  t.equal(res7.headers.get("Access-Control-Expose-Headers"), "*");
});

// Test timeout - using a URL that will definitely timeout
// Use a dedicated agent so sockets close promptly
const agent = new Agent({ keepAliveTimeout: 0, keepAliveMaxTimeout: 0 });

t.test("Proxy API timeout", async (t) => {
  t.teardown(() => agent.close());
  await t.rejects(
    fetch("/proxy/https://httpbin.org/delay/35", {
      dispatcher: agent,
      signal: AbortSignal.timeout(1000),
      headers: { Connection: "close" },
    }),
    { name: "AbortError" },
  );
});
