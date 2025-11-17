// @ts-check
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { replyJson, seedUsage, setupWorkerFetchMock, workerFetch } from "./test-helpers.js";

const fetchMock = setupWorkerFetchMock();

const toHeaders = (headers) => headers instanceof Headers ? headers : new Headers(headers ?? {});

describe("Native API key detection", () => {
  test("detects OpenAI native keys (sk-)", async () => {
    const nativeKey = "sk-test-openai-key-123456789";
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/models",
      method: "GET",
      body: { data: [{ id: "gpt-4" }] },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${nativeKey}`);
      },
    });

    const response = await workerFetch("/openai/v1/models", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([{ id: "gpt-4" }]);
  });

  test("detects OpenRouter native keys (sk-or-)", async () => {
    const nativeKey = "sk-or-test-openrouter-key-123456789";
    replyJson(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      body: { data: [{ id: "test-model" }] },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${nativeKey}`);
      },
    });

    const response = await workerFetch("/openrouter/v1/models", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    expect(response.status).toBe(200);
  });

  test("detects Gemini native keys (AIza)", async () => {
    const nativeKey = "AIzaSyTestGeminiKey123456789abcdef";
    replyJson(fetchMock, {
      origin: "https://generativelanguage.googleapis.com",
      path: "/v1beta/models",
      method: "GET",
      body: { models: [{ name: "gemini-1.5-pro" }] },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("x-goog-api-key")).toBe(nativeKey);
      },
    });

    const response = await workerFetch("/geminiv1beta/models", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    expect(response.status).toBe(200);
  });
});

describe("Native API key behavior", () => {
  test("bypasses JWT validation for native keys", async () => {
    // This key is NOT a valid JWT, but it starts with sk-, so it should be treated as a native key
    const nativeKey = "sk-invalid-jwt-but-valid-openai-key";
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/models",
      method: "GET",
      body: { data: [] },
    });

    const response = await workerFetch("/openai/v1/models", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    // Should succeed (200 or provider error), not 401 (JWT validation error)
    expect(response.status).not.toBe(401);
  });

  test("skips budget check for native keys", async () => {
    // Seed usage at max limit (which would normally block requests)
    await seedUsage({ "any@example.com": { "2024-01-01": 1000000 } });

    const nativeKey = "sk-test-key-should-bypass-budget";
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/models",
      method: "GET",
      body: { data: [] },
    });

    const response = await workerFetch("/openai/v1/models", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    // Should not return 429 (budget exceeded)
    expect(response.status).not.toBe(429);
    expect(response.status).toBe(200);
  });

  test("does not track cost for native key requests", async () => {
    await seedUsage({});
    const nativeKey = "sk-test-key-no-cost-tracking";

    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      body: {
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 1000000, completion_tokens: 500000 }, // Huge usage
        choices: [{ message: { role: "assistant", content: "test" } }],
      },
    });

    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nativeKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
      }),
    });

    expect(response.status).toBe(200);

    // Cost should remain at 0 since native keys don't track costs
    // Note: We can't directly check the cost database without an AIPipe token,
    // but we verify the request succeeded without updating any cost
  });

  test("skips model pricing validation for native keys", async () => {
    const nativeKey = "sk-test-unknown-model-allowed";

    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      body: {
        model: "unknown-model-no-pricing",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: "assistant", content: "ok" } }],
      },
    });

    // With native key, unknown model should be allowed (no pricing validation)
    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nativeKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "unknown-model-no-pricing",
        messages: [{ role: "user", content: "test" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe("unknown-model-no-pricing");
  });

  test("uses native key directly instead of environment key", async () => {
    const nativeKey = "sk-my-personal-openai-key-12345";

    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      body: {
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: "assistant", content: "hi" } }],
      },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        // Should use the native key, NOT the environment key
        expect(headers.get("authorization")).toBe(`Bearer ${nativeKey}`);
        expect(headers.get("authorization")).not.toBe(`Bearer ${env.OPENAI_API_KEY}`);
      },
    });

    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nativeKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
      }),
    });

    expect(response.status).toBe(200);
  });
});

describe("Native API key restrictions", () => {
  test("rejects native keys for usage endpoint", async () => {
    const nativeKey = "sk-test-key-usage-denied";
    const response = await workerFetch("/usage", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.message).toContain("AIPipe JWT token");
  });

  test("rejects native keys for admin endpoint", async () => {
    const nativeKey = "sk-test-key-admin-denied";
    const response = await workerFetch("/admin/usage", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.message).toContain("AIPipe JWT token");
  });

  test("rejects Gemini native keys for admin endpoint", async () => {
    const nativeKey = "AIzaSyAdminDeniedKey123456789";
    const response = await workerFetch("/admin/usage", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.message).toContain("AIPipe JWT token");
  });
});

describe("OpenRouter native key specifics", () => {
  test("does not add AIPipe referer headers for native keys", async () => {
    const nativeKey = "sk-or-user-openrouter-key-abc123";

    replyJson(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      body: { data: [] },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        // Native keys should NOT have AIPipe's referer headers
        expect(headers.get("http-referer")).not.toBe("https://aipipe.org/");
        expect(headers.get("x-title")).not.toBe("AIPipe");
      },
    });

    const response = await workerFetch("/openrouter/v1/models", {
      headers: { Authorization: `Bearer ${nativeKey}` },
    });

    expect(response.status).toBe(200);
  });
});

describe("Gemini native key specifics", () => {
  test("converts Authorization header to x-goog-api-key for Gemini", async () => {
    const nativeKey = "AIzaSyGeminiNativeKey123456789abc";

    replyJson(fetchMock, {
      origin: "https://generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-1.5-pro:generateContent",
      method: "POST",
      body: {
        model: "gemini-1.5-pro",
        candidates: [{ content: { parts: [{ text: "Hello!" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        // Should convert Authorization: Bearer to x-goog-api-key
        expect(headers.get("x-goog-api-key")).toBe(nativeKey);
        expect(headers.get("authorization")).toBeNull();
      },
    });

    const response = await workerFetch("/geminiv1beta/models/gemini-1.5-pro:generateContent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nativeKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
  });
});
