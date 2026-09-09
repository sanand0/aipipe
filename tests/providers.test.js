// @ts-check
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import pricing from "../src/pricing.json";
import { providers } from "../src/providers.js";
import {
  createTestToken,
  getBudgetForEmail,
  readUsage,
  replyJson,
  replyStream,
  seedUsage,
  setupWorkerFetchMock,
  TEST_EMAIL,
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

  // The output ceiling a caller declares is priced in dollars and compared against what is left of
  // their budget. Figures are derived from pricing.json and config.example.js rather than hardcoded,
  // so these tests fail loudly if either changes rather than silently testing the wrong number.
  const BUDGET_MODEL = "gpt-5.5";
  const [, BUDGET_OUTPUT_PRICE] = pricing.openai[BUDGET_MODEL];
  const outputCostOf = (tokens) => (tokens * BUDGET_OUTPUT_PRICE) / 1e6;

  // Seed usage so the caller has `remaining` dollars left, and return that figure computed the same
  // way the worker computes it (limit - usage), so the formatted amount can be asserted exactly.
  const seedRemainingBudget = async (remaining) => {
    const { limit } = getBudgetForEmail(TEST_EMAIL);
    const used = limit - remaining;
    await seedUsage({ [TEST_EMAIL]: { [new Date().toISOString().slice(0, 10)]: used } });
    return limit - used;
  };

  const chatPath = "/openai/v1/chat/completions";
  const chatBody = { messages: [{ role: "user", content: "Hello" }] };

  const postJson = (path, token, payload) =>
    workerFetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

  const mockOpenAIChat = () =>
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      body: {
        model: BUDGET_MODEL,
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: "assistant", content: "hi" } }],
      },
    });

  test.each([
    ["max_tokens", chatPath, chatBody],
    ["max_completion_tokens", chatPath, chatBody],
    ["max_output_tokens", "/openai/v1/responses", { input: "Hello" }],
  ])("rejects a request whose %s can exceed the remaining budget", async (limitField, path, body) => {
    const token = await createTestToken();
    const maxTokens = 1000;
    const outputCost = outputCostOf(maxTokens);
    // Leave a third of the ceiling's cost, so the ceiling clearly exceeds it
    const remaining = await seedRemainingBudget(outputCost / 3);

    const response = await postJson(path, token, { model: BUDGET_MODEL, [limitField]: maxTokens, ...body });

    expect(response.status).toBe(429);
    const result = await response.json();
    expect(result.message).toContain(`Maximum output cost $${outputCost.toFixed(6)}`);
    expect(result.message).toContain(`remaining budget $${remaining.toFixed(6)}`);
  });

  test("allows a request whose declared ceiling fits the remaining budget", async () => {
    const token = await createTestToken();
    const maxTokens = 100;
    // Triple the ceiling's cost is left, so the request is affordable
    await seedRemainingBudget(outputCostOf(maxTokens) * 3);
    mockOpenAIChat();

    const response = await postJson(chatPath, token, {
      model: BUDGET_MODEL,
      max_completion_tokens: maxTokens,
      ...chatBody,
    });

    expect(response.status).toBe(200);
  });

  test("skips the ceiling check when the request declares no output limit", async () => {
    const token = await createTestToken();
    // Far less budget than an unbounded request could spend. The pre-check has no ceiling to price,
    // so the request proceeds and is only charged after the fact. Documents a known gap: callers
    // that omit an output limit are not pre-checked at all.
    await seedRemainingBudget(outputCostOf(1));
    mockOpenAIChat();

    const response = await postJson(chatPath, token, { model: BUDGET_MODEL, ...chatBody });

    expect(response.status).toBe(200);
  });

  test("coerces a string output limit before comparing against the budget", async () => {
    const token = await createTestToken();
    const maxTokens = 1000;
    await seedRemainingBudget(outputCostOf(maxTokens) / 3);

    const response = await postJson(chatPath, token, {
      model: BUDGET_MODEL,
      max_tokens: String(maxTokens),
      ...chatBody,
    });

    expect(response.status).toBe(429);
    const result = await response.json();
    expect(result.message).toContain(`Maximum output cost $${outputCostOf(maxTokens).toFixed(6)}`);
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
    expect(forwardedPayload.store).toBe(true);
    expect(forwardedPayload.metadata).toEqual({ aipipe_email: "test@example.com" });

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });

  test("adds user email to responses metadata without dropping existing metadata", async () => {
    const token = await createTestToken();
    let capturedBody;

    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/responses",
      method: "POST",
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${env.OPENAI_API_KEY}`);
        capturedBody = opts.body;
      },
      body: {
        model: "gpt-5-nano",
        usage: { input_tokens: 8, output_tokens: 4 },
        output: [{ role: "assistant", content: [{ text: "hi" }] }],
      },
    });

    const response = await workerFetch("/openai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        input: "Hello",
        metadata: { trace_id: "trace-123" },
      }),
    });

    expect(response.status).toBe(200);
    const forwardedPayload = parseBody(capturedBody);
    expect(forwardedPayload.store).toBe(true);
    expect(forwardedPayload.metadata).toEqual({
      trace_id: "trace-123",
      aipipe_email: "test@example.com",
    });
  });

  test("charges requested model pricing when the OpenAI response model is unknown", async () => {
    const token = await createTestToken();
    await seedUsage({});

    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/responses",
      method: "POST",
      body: {
        model: "gpt-5-nano-2026-03-17",
        usage: { input_tokens: 1000, output_tokens: 1000 },
        output: [{ role: "assistant", content: [{ text: "hi" }] }],
      },
    });

    const response = await workerFetch("/openai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5-nano", input: "Hello" }),
    });

    expect(response.status).toBe(200);
    const usage = await readUsage(token);
    expect(usage.cost).toBeCloseTo(0.00045, 8);
  });

  test("charges expensive default pricing when no OpenAI model price is known", async () => {
    const { cost } = await providers.openai.cost({
      model: "unknown-response-model",
      requestedModel: "unknown-request-model",
      usage: { input_tokens: 1000, output_tokens: 1000 },
    });

    expect(cost).toBeCloseTo(0.21, 8);
  });

  test.each([
    ["gpt-5.5", [5, 30]],
    ["gpt-5.5-2026-04-23", [5, 30]],
    ["gpt-5.5-pro", [30, 180]],
    ["gpt-5.5-pro-2026-04-23", [30, 180]],
    ["gpt-5.6", [5, 30]],
    ["gpt-5.6-sol", [5, 30]],
    ["gpt-5.6-terra", [2, 12]],
    ["gpt-5.6-luna", [0.2, 1.2]],
  ])("calculates current pricing for %s", async (model, expectedPricing) => {
    expect(pricing.openai[model]).toEqual(expectedPricing);
    const { cost } = await providers.openai.cost({
      model,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });

    expect(cost).toBe(expectedPricing[0] + expectedPricing[1]);
  });

  test("adds user email to embeddings requests", async () => {
    const token = await createTestToken();
    let capturedBody;

    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/embeddings",
      method: "POST",
      assertRequest: (opts) => {
        const headers = toHeaders(opts.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${env.OPENAI_API_KEY}`);
        capturedBody = opts.body;
      },
      body: {
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 8, total_tokens: 8 },
      },
    });

    const response = await workerFetch("/openai/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "Hello",
      }),
    });

    expect(response.status).toBe(200);
    const forwardedPayload = parseBody(capturedBody);
    expect(forwardedPayload.user).toBe("test@example.com");
  });

  test("calculates cost for transcribe models with audio input tokens", async () => {
    const token = await createTestToken();
    await seedUsage({});
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/audio/transcriptions",
      method: "POST",
      body: {
        text: "Hello world",
        model: "gpt-4o-transcribe",
        usage: {
          type: "tokens",
          total_tokens: 402,
          input_tokens: 300,
          input_token_details: { text_tokens: 0, audio_tokens: 300 },
          output_tokens: 102,
        },
      },
    });

    const response = await workerFetch("/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-transcribe", file: "audio.wav" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.text).toBe("Hello world");

    const usage = await readUsage(token);
    // Cost = (0 text input * 0.6 + 300 audio input * 6 + 102 text output * 0) / 1e6
    // = 1800 / 1e6 = 0.0018
    expect(usage.cost).toBeCloseTo(0.0018, 4);
  });

  test("calculates cost for audio preview models with audio output tokens", async () => {
    const token = await createTestToken();
    await seedUsage({});
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      body: {
        model: "gpt-4o-audio-preview-2025-06-03",
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 40,
          total_tokens: 49,
          prompt_tokens_details: {
            cached_tokens: 0,
            audio_tokens: 0,
            text_tokens: 9,
            image_tokens: 0,
          },
          completion_tokens_details: {
            reasoning_tokens: 0,
            audio_tokens: 28,
            accepted_prediction_tokens: 0,
            rejected_prediction_tokens: 0,
            text_tokens: 12,
          },
        },
      },
    });

    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-audio-preview-2025-06-03",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices?.[0]?.message?.content).toBe("hi");

    const usage = await readUsage(token);
    // Cost = (9 text input * 2.5 + 0 audio input * 100 + 12 text output * 10 + 28 audio output * 200) / 1e6
    // = (22.5 + 0 + 120 + 5600) / 1e6 = 5742.5 / 1e6 = 0.0057425
    expect(usage.cost).toBeCloseTo(0.0057425, 6);
  });

  test("avoids double-counting when token details exist but text_tokens is missing", async () => {
    const token = await createTestToken();
    await seedUsage({});
    replyJson(fetchMock, {
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      body: {
        model: "gpt-4o-audio-preview",
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          prompt_tokens_details: { audio_tokens: 5 }, // text_tokens missing - should compute as 10-5=5
          completion_tokens_details: { audio_tokens: 5 }, // text_tokens missing - should compute as 20-5=15
        },
      },
    });

    const response = await workerFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-audio-preview",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(response.status).toBe(200);
    const usage = await readUsage(token);
    // Cost = (5 text input * 2.5 + 5 audio input * 100 + 15 text output * 10 + 5 audio output * 200) / 1e6
    // = (12.5 + 500 + 150 + 1000) / 1e6 = 1662.5 / 1e6 = 0.0016625
    expect(usage.cost).toBeCloseTo(0.0016625, 6);
  });
});

describe("OpenRouter provider", () => {
  test("uses OpenRouter reported usage cost when model aliases differ", async () => {
    const token = await createTestToken("user@example.com", { useSalt: true });
    await seedUsage({});

    replyJson(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      body: {
        data: [{
          id: "anthropic/claude-sonnet-4.6",
          pricing: { prompt: 0.000003, completion: 0.000015 },
        }],
      },
    });

    replyStream(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      events: [
        'data: {"model":"anthropic/claude-4.6-sonnet-20260217","choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"model":"anthropic/claude-4.6-sonnet-20260217","usage":{"prompt_tokens":392824,"completion_tokens":1195,"cost":1.853994}}',
        "data: [DONE]",
      ],
    });

    const response = await workerFetch("/openrouter/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    const usage = await readUsage(token);
    expect(usage.cost).toBeCloseTo(1.853994, 6);
  });

  test("rejects OpenRouter requests whose estimated prompt cost exceeds remaining budget", async () => {
    const token = await createTestToken("test@example.com");
    await seedUsage({});

    replyJson(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      body: {
        data: [{
          id: "expensive/test-model",
          pricing: { prompt: 1, completion: 0 },
        }],
      },
    });

    const response = await workerFetch("/openrouter/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "expensive/test-model",
        messages: [{ role: "user", content: "This should be rejected before OpenRouter is called." }],
      }),
    });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.message).toContain("Estimated request cost");
  });

  test("streams chat completions and accrues cost", async () => {
    const token = await createTestToken("user@example.com", { useSalt: true });
    await seedUsage({});
    let capturedBody;

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
        capturedBody = opts.body;
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
    const forwardedPayload = parseBody(capturedBody);
    expect(forwardedPayload.user).toBe("user@example.com");

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });
});

describe("Gemini provider", () => {
  test("rewrites authorization header, leaves the request body unchanged, and calculates cost for embeddings", async () => {
    const token = await createTestToken("test@example.com");
    await seedUsage({});
    let capturedBody;

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
        capturedBody = opts.body;
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
    expect(parseBody(capturedBody)).toEqual({
      content: { role: "user", parts: [{ text: "hello" }] },
    });

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });
});

describe("Similarity endpoint", () => {
  test("returns similarity matrix and charges usage", async () => {
    const token = await createTestToken();
    await seedUsage({});
    let capturedBody;

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
        capturedBody = opts.body;
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
    const forwardedPayload = parseBody(capturedBody);
    expect(forwardedPayload.user).toBe("test@example.com");

    const usage = await readUsage(token);
    expect(usage.cost).toBeGreaterThan(0);
  });
});
