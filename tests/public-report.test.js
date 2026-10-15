// @ts-check
import { createExecutionContext, createScheduledController, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/worker.js";
import { sseTransform } from "../src/providers.js";

const stub = () => env.AIPIPE_COST.get(env.AIPIPE_COST.idFromName("default"));

async function clearUsage() {
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM cost");
    state.storage.sql.exec("DELETE FROM provider_usage");
  });
}

describe("public prediction-market usage snapshot", () => {
  test("aggregates seven UTC days, distinct IITM users, and exclusive provider-count buckets", async () => {
    await clearUsage();
    await runInDurableObject(stub(), async (_instance, state) => {
      const insert = (date, email, provider, spend, input, output) => state.storage.sql.exec(
        "INSERT INTO provider_usage (date, email, provider, spend_usd, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)",
        date, email, provider, spend, input, output,
      );
      insert("2026-10-15", "one@ds.iitm.ac.in", "openai", 1, 10, 5);
      insert("2026-10-15", "two@iitm.ac.in", "openai", 2, 20, 10);
      insert("2026-10-15", "two@iitm.ac.in", "gemini", 3, 30, 15);
      for (const [provider, input] of [["openai", 100], ["gemini", 200], ["openrouter", 300]]) {
        insert("2026-10-15", "three@outside.com", provider, 1, input, 10);
      }
      insert("2026-10-14", "older@research.iitm.ac.in", "openrouter", 4, 40, 20);
      insert("2026-10-08", "out-of-range@ds.iitm.ac.in", "gemini", 900, 999, 999);
    });
    const report = await stub().publicReport("2026-10-15T12:00:00Z");
    expect(report.days).toHaveLength(7);
    expect(report.days.map((day) => day.date)).toEqual([
      "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
    ]);
    const today = report.days.at(-1);
    expect(today.complete).toBe(false);
    expect(today.total).toEqual({ spend_usd: 9, input_tokens: 660, output_tokens: 60 });
    expect(today.providers.openai).toEqual({ spend_usd: 4, input_tokens: 130, output_tokens: 25 });
    expect(today.iitm_users).toBe(1); // Only emails ending in .iitm.ac.in
    expect(today.users_by_provider_count).toEqual({ "1": 1, "2": 1, "3+": 1 });
    expect(report.days.at(-2).iitm_users).toBe(1);
    expect(report.days[0].total.spend_usd).toBe(0);
    expect(JSON.stringify(report)).not.toContain("@iitm.ac.in");
  });

  test("adds only positive-cost metered usage, and does not break existing budget cost", async () => {
    await clearUsage();
    await stub().add("someone@ds.iitm.ac.in", 0.25, "gemini", { prompt_tokens: 25, completion_tokens: 4 });
    await stub().add("someone@ds.iitm.ac.in", 0.5, "openai", { input_tokens: 40, output_tokens: 8 });
    await stub().add("someone@ds.iitm.ac.in", 0, "openrouter", { prompt_tokens: 10000, completion_tokens: 1000 });
    const today = new Date().toISOString().slice(0, 10);
    const report = await stub().publicReport(new Date().toISOString());
    const day = report.days.find((item) => item.date === today);
    expect(day.total).toEqual({ spend_usd: 0.75, input_tokens: 65, output_tokens: 12 });
    expect(day.users_by_provider_count).toEqual({ "1": 0, "2": 1, "3+": 0 });
    expect(day.providers.openrouter).toBeUndefined();
    expect(await stub().cost("someone@ds.iitm.ac.in", 1)).toBeCloseTo(0.75);
  });

  test("scheduled publication writes a fixed JSON object, not an API response", async () => {
    await clearUsage();
    const scheduledTime = Date.parse("2026-10-15T12:00:00Z");
    await worker.scheduled(createScheduledController({ scheduledTime, cron: "0 */6 * * *" }), env, createExecutionContext());
    const object = await env.PUBLIC_STATS.get("usage.json");
    expect(object).not.toBeNull();
    expect(object.httpMetadata.contentType).toBe("application/json");
    const data = await object.json();
    expect(data.scheduled_for).toBe("2026-10-15T12:00:00.000Z");
    expect(data.days).toHaveLength(7);
    expect(data.days.at(-1).complete).toBe(false);
  });
});

test("SSE accounting uses the last meaningful report, ignoring empty tail events", async () => {
  const captured = [];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of [
        'data: {"model":"gpt-5-nano","usage":{"input_tokens":2,"output_tokens":1}}\n\n',
        'data: {"model":"gpt-5-nano","usage":{"input_tokens":20,"output_tokens":10}}\n\n',
        'data: {"model":"gpt-5-nano","usage":{}}\n\ndata: [DONE]\n\n',
      ]) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  await new Response(stream.pipeThrough(sseTransform("openai", (data) => captured.push(data)))).text();
  expect(captured).toEqual([{ model: "gpt-5-nano", usage: { input_tokens: 20, output_tokens: 10 } }]);
});
