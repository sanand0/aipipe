// @ts-check
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  createTestToken,
  readUsage,
  replyJson,
  replyStream,
  seedUsage,
  setupWorkerFetchMock,
  workerFetch,
} from "./test-helpers.js";

const fetchMock = setupWorkerFetchMock();

const toHeaders = (headers) => headers instanceof Headers ? headers : new Headers(headers ?? {});
const parseBody = (body) => {
  if (!body) return null;
  if (typeof body === "string") return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString());
  if (Array.isArray(body)) return JSON.parse(Buffer.from(body).toString());
  if (body.type === "Buffer") return JSON.parse(Buffer.from(body.data).toString());
  return JSON.parse(String(body));
};

describe("OpenAI provider", () => {
  test("rejects non-JSON bodies", async () => {
    const token = await createTestToken();
    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: "not-json",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toContain("Pass a JSON body");
  });

  test("rejects unknown OpenAI model pricing", async () => {
    const token = await createTestToken();
    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "unknown-model", messages: [] }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toContain("pricing unknown");
  });

  test("proxies chat completions, augments stream options, and accrues usage", async () => {
    const token = await createTestToken();
    await seedUsage({});
    let capturedBody;
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${env.OPENAI_API_KEY}`);
        capturedBody = opts.body;
      },
      body: {
        model: "gpt-4o-mini-2024-07-18",
        usage: { prompt_tokens: 1000, completion_tokens: 400 },
        choices: [{ message: { role: "assistant", content: "hi" } }],
      },
    });

    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-2024-07-18",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices?.[0]?.message?.content).toBe("hi");
    const forwardedPayload = parseBody(capturedBody);
    expect(forwardedPayload.stream_options).toEqual({ include_usage: true });

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });
});

describe("OpenRouter provider", () => {
  test("streams chat completions and accrues cost", async () => {
    const token = await createTestToken("user@example.com", { useSalt: true });
    await seedUsage({});

    replyJson(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      body: {
        data: [{
          id: "openrouter/test-model",
          pricing: { prompt: 0.001, completion: 0.002 },
        }],
      },
    });

    replyStream(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      events: [
        'data: {"model":"openrouter/test-model","usage":{"prompt_tokens":500,"completion_tokens":200}}',
        "data: [DONE]",
      ],
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${env.OPENROUTER_API_KEY}`);
      },
    });

    const response = await workerFetch("/openrouter/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });
});

describe("Gemini provider", () => {
  test("rewrites authorization header and calculates cost for embeddings", async () => {
    const token = await createTestToken("test@example.com");
    await seedUsage({});

    replyJson(fetchMock, {
      origin: "https://generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-1.5-pro:embedContent",
      method: "POST",
      body: {
        model: "gemini-1.5-pro",
        similarity: [],
        usageMetadata: { promptTokenCount: 1200 },
      },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("x-goog-api-key")).toBe(env.GEMINI_API_KEY);
      },
    });

    const response = await workerFetch("/geminiv1beta/models/gemini-1.5-pro:embedContent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: { role: "user", parts: [{ text: "hello" }] },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.usageMetadata?.promptTokenCount ?? body.usage?.prompt_tokens).toBeDefined();

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });
});

describe("Similarity endpoint", () => {
  test("returns similarity matrix and charges usage", async () => {
    const token = await createTestToken();
    await seedUsage({});

    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/embeddings",
      method: "POST",
      body: {
        data: [
          { embedding: [1, 0] },
          { embedding: [0, 1] },
        ],
        usage: { prompt_tokens: 8 },
      },
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${env.OPENAI_API_KEY}`);
      },
    });

    const response = await workerFetch("/similarity", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        docs: ["hello", "world"],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.similarity)).toBe(true);
    expect(body.similarity.length).toBe(2);

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });
});
