// @ts-check
import { expect, test } from "vitest";
import { workerFetch } from "./test-helpers.js";

test("responds to OPTIONS preflight with requested headers", async () => {
  const requestedHeaders = "X-Custom-Header";
  const response = await workerFetch("/openrouter/v1/models", {
    method: "OPTIONS",
    headers: { "Access-Control-Request-Headers": requestedHeaders },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
  expect(response.headers.get("access-control-max-age")).toBe("86400");
  expect(response.headers.get("access-control-allow-headers")).toBe(requestedHeaders);
});
