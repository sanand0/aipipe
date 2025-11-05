// @ts-check
import { describe, expect, test } from "vitest";
import { createTestToken, replyJson, setupWorkerFetchMock, workerFetch } from "./test-helpers.js";

const fetchMock = setupWorkerFetchMock();

describe("authentication and authorization", () => {
  test("rejects requests without Authorization header", async () => {
    const response = await workerFetch("/openrouter/v1/models");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.message).toContain("Missing Authorization");
  });

  test("rejects requests with invalid JWT", async () => {
    const response = await workerFetch("/openrouter/v1/models", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.message.toLowerCase()).toContain("invalid");
  });

  test("rejects token without required salt entry", async () => {
    const token = await createTestToken("user@example.com");
    const response = await workerFetch("/openrouter/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.message.toLowerCase()).toContain("no longer valid");
  });

  test("accepts salted token and proxies request to OpenRouter", async () => {
    const token = await createTestToken("user@example.com", { useSalt: true });
    replyJson(fetchMock, {
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      body: { data: [{ id: "test-model" }] },
    });

    const response = await workerFetch("/openrouter/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.json();
    expect(body.data).toEqual([{ id: "test-model" }]);
  });

  test("returns 404 for unknown provider paths", async () => {
    const token = await createTestToken();
    const response = await workerFetch("/does-not-exist/v1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.message).toMatch(/Unknown provider/i);
  });
});
