import * as jose from "jose";

// Convert date to YYYY-MM-DD in UTC
export const ymd = (date) => date.toISOString().slice(0, 10);

export function updateHeaders(headers, skip, update) {
  const result = new Headers();
  for (const [key, value] of headers) if (!skip.some((pattern) => pattern.test(key))) result.append(key, value);
  for (const [key, value] of Object.entries(update ?? {})) result.set(key, value);
  return result;
}

export function addCors(headers) {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST");
  headers.set("access-control-allow-headers", "Authorization, Content-Type");
  headers.set("access-control-expose-headers", "*");
  return headers;
}

export async function createToken(email, secret, extraParams = {}) {
  return await new jose.SignJWT({ email, ...extraParams })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(secret));
}
