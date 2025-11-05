// @ts-check
import { expect, test } from "vitest";
import { createTestToken, replyJson, setupWorkerFetchMock, workerFetch } from "./test-helpers.js";

const fetchMock = setupWorkerFetchMock();

test("requires URLs to begin with http", async () => {
  const response = await workerFetch("/proxy/ftp://example.com/data");
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.message).toContain("URL must begin with http");
});

test("proxies requests and exposes origin headers", async () => {
  replyJson(fetchMock, {
    origin: "https://example.org",
    path: (incoming) => incoming.startsWith("/api"),
    method: "GET",
    assertRequest: (opts) => {
      const headers = opts.headers instanceof Headers ? opts.headers : new Headers(opts.headers ?? {});
      expect(headers.get("x-test-header")).toBe("123");
    },
    body: { ok: true },
  });

  const token = await createTestToken();
  const response = await workerFetch("/proxy/https://example.org/api?x=1", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Test-Header": "123",
    },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("x-proxy-url")).toBe("https://example.org/api?x=1");
  const body = await response.json();
  expect(body.ok).toBe(true);
});
