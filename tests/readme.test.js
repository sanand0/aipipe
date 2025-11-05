// @ts-check
import { expect, test } from "vitest";

test("README authorization examples include Bearer prefix", async () => {
  const module = await import("../README.md?raw");
  const readme = module.default ?? module;
  expect(readme).toContain("Authorization: Bearer");

  const invalid = [...readme.matchAll(/Authorization:\s*([^\n]+)/g)].filter(
    ([, header]) => !/Bearer\s+/i.test(header),
  );
  expect(invalid).toEqual([]);
});
