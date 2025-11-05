// @ts-check
import { describe, expect, test } from "vitest";
import { ADMIN_EMAIL, createTestToken, readUsage, seedUsage, workerFetch } from "./test-helpers.js";

describe("admin endpoints", () => {
  test("rejects non-admin access", async () => {
    const token = await createTestToken("test@example.com");
    const response = await workerFetch("/admin/usage", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.message.toLowerCase()).toContain("admin access required");
  });

  test("returns all usage for admins", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await seedUsage({ "user@example.com": { [today]: 1.25 } });
    const adminToken = await createTestToken(ADMIN_EMAIL);

    const response = await workerFetch("/admin/usage", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toEqual(expect.arrayContaining([expect.objectContaining({ email: "user@example.com" })]));
  });

  test("issues tokens for specified users", async () => {
    const adminToken = await createTestToken(ADMIN_EMAIL);
    const response = await workerFetch("/admin/token?email=someone@example.com", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const { token } = await response.json();
    expect(typeof token).toBe("string");

    const usageResponse = await workerFetch("/usage", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(usageResponse.status).toBe(200);
  });

  test("overwrites cost entries", async () => {
    await seedUsage({});
    const adminToken = await createTestToken(ADMIN_EMAIL);
    const today = new Date().toISOString().slice(0, 10);
    const payload = { email: "cost-test@example.com", date: today, cost: 4.5 };

    const response = await workerFetch("/admin/cost", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toContain(String(payload.cost));

    const token = await createTestToken(payload.email);
    const usage = await readUsage(token);
    expect(usage.cost).toBeCloseTo(payload.cost, 5);
  });
});
