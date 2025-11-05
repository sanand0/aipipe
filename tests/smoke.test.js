// @ts-check
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("responds with unknown provider for invalid route", async () => {
  const response = await SELF.fetch("https://example.com/does-not-exist");
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.message).toContain("Unknown provider");
});
