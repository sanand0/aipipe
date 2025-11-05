// @ts-check
import { describe, expect, test } from "vitest";
import { createTestToken, getBudgetForEmail, readUsage, seedUsage, workerFetch } from "./test-helpers.js";

describe("usage and budgeting", () => {
  test("returns accumulated usage with configured limit", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await seedUsage({ "test@example.com": { [today]: 0.123 } });
    const token = await createTestToken("test@example.com");

    const usage = await readUsage(token);
    const { limit, days } = getBudgetForEmail("test@example.com");

    expect(usage.email).toBe("test@example.com");
    expect(usage.cost).toBeCloseTo(0.123, 5);
    expect(Array.isArray(usage.usage)).toBe(true);
    expect(usage.limit).toBe(limit);
    expect(usage.days).toBe(days);
  });

  test("applies domain budget fallback when individual budget missing", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const email = "domain-user@example.com";
    await seedUsage({ [email]: { [today]: 0.5 } });
    const token = await createTestToken(email);

    const usage = await readUsage(token);
    const { limit } = getBudgetForEmail(email);

    expect(usage.limit).toBe(limit);
    expect(usage.limit).not.toBe(getBudgetForEmail("someone@else.com").limit);
    expect(usage.cost).toBeCloseTo(0.5, 5);
  });

  test("blocks requests when user has zero budget", async () => {
    const token = await createTestToken("blocked@example.com");
    const response = await workerFetch("/openrouter/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.message).toContain("Usage $0");
  });
});
