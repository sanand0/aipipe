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
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Expose-Headers", "*");
  return headers;
}

export async function createToken(email, secret, extraParams = {}) {
  return await new jose.SignJWT({ email, ...extraParams })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(secret));
}
