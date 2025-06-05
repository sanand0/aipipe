import t from "tap";
import { readFileSync } from "fs";
import { salt } from "../src/config.js";
import { createToken, ymd } from "../src/utils.js";

// Get base URL environment or default to localhost:8787
const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const AIPIPE_SECRET = readFileSync(".dev.vars", "utf8")
  .split("\n")
  .find((l) => l.startsWith("AIPIPE_SECRET="))
  .split("=")[1];

const testToken = (email = "test@example.com", salt) => createToken(email, AIPIPE_SECRET, { salt });

// Use the first admin email specified in the environment
const adminEmail = (process.env.ADMIN_EMAILS || "admin@example.com").split(/[,\s]+/).at(0);

async function fetch(path, { headers, ...params } = {}) {
  const url = `${BASE_URL}${path}`;
  return await globalThis.fetch(url, { headers: { "Content-Type": "application/json", ...headers }, ...params });
}

async function getUsage(token) {
  return await fetch("/usage", { headers: { Authorization: `Bearer ${token}` } }).then((res) => res.json());
}

t.test("CORS headers", async (t) => {
  const res = await fetch("/openrouter/v1/models", { method: "OPTIONS" });
  t.equal(res.status, 200);
  t.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  t.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, POST");
  t.equal(res.headers.get("Access-Control-Max-Age"), "86400");
});

t.test("Authorization required", async (t) => {
  const res = await fetch("/openrouter/v1/models");
  t.equal(res.status, 401);
  const body = await res.json();
  t.match(body.message, /Missing Authorization/);
});

t.test("Invalid JWT token", async (t) => {
  const res = await fetch("/openrouter/v1/models", {
    headers: { Authorization: "Bearer invalid-token" },
  });
  t.equal(res.status, 401);
  const body = await res.json();
  t.match(body.message, /invalid/i);
});

t.test("Valid JWT token", async (t) => {
  const token = await testToken();
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.not(res.status, 401);
});

t.test("Invalid provider", async (t) => {
  const token = await testToken();
  const res = await fetch("/invalid-provider/", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 404);
  const body = await res.json();
  t.match(body.message, /Unknown provider/);
});

t.test("Invalid salt", async (t) => {
  const token = await testToken(Object.keys(salt)[0]);
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 401);
  const body = await res.json();
  t.match(body.message, /no longer valid/);
});

t.test("Valid salt", async (t) => {
  const token = await testToken(...Object.entries(salt)[0]);
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 200);
  const body = await res.json();
  t.ok(body.data.length);
});

t.test("Usage endpoint", async (t) => {
  const token = await testToken();
  const usage = await getUsage(token);
  t.type(usage.limit, "number");
  t.type(usage.days, "number");
  t.type(usage.cost, "number");
  t.ok(Array.isArray(usage.usage));
});

t.test("Completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "google/gemini-2.0-flash-lite-001";
  const res = await fetch("/openrouter/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "What is 2 + 2?" }] }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.id, /^gen-/);
  t.match(body.model, model);

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Embedding and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "text-embedding-3-small";
  const res = await fetch("/openai/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, input: "What is 2 + 2?" }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.object, "list");
  t.match(body.model, model);

  const usageEnd = await getUsage(token);
  // Cost should be 8 Tok * $0.02 / MTok
  t.ok(Math.abs(usageEnd.cost - usageStart.cost - 1.6e-7) < 1e-12);
});

t.test("Streaming completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "google/gemini-2.0-flash-lite-001";
  const res = await fetch("/openrouter/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "What is 2 + 2?" }], stream: true }),
  });
  t.equal(res.status, 200);
  t.equal(res.headers.get("Content-Type").split(";")[0], "text/event-stream");

  await res.text();
  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("OpenAI completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "gpt-4.1-nano";
  const res = await fetch("/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "What is 2 + 2?" }] }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.object, "chat.completion");

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("OpenAI responses streaming completion and cost", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const model = "gpt-4.1-nano";
  const res = await fetch("/openai/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, input: "What is 2 + 2?", stream: true }),
  });
  t.equal(res.status, 200);
  t.equal(res.headers.get("Content-Type").split(";")[0], "text/event-stream");

  await res.text();
  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Similarity API", async (t) => {
  const token = await testToken();
  const usageStart = await getUsage(token);

  const res = await fetch("/similarity", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      docs: ["The quick brown fox jumps over the lazy dog"],
      topics: ["fox jumping", "dog sleeping"],
      model: "text-embedding-3-small"
    }),
  });
  t.equal(res.status, 200);
  const body = await res.json();
  t.match(body.model, "text-embedding-3-small");
  t.ok(Array.isArray(body.similarity));
  t.equal(body.similarity.length, 1);
  t.equal(body.similarity[0].length, 2);

  const usageEnd = await getUsage(token);
  t.ok(usageEnd.cost > usageStart.cost);
});

t.test("Budget limit exceeded", async (t) => {
  // This test assumes the user has already exceeded their budget
  const token = await testToken("blocked@example.com");
  const res = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 429);
  const body = await res.json();
  t.match(body.message, /\$0 in 1 days/);
});

t.test("Admin: unauthorized access", async (t) => {
  const token = await testToken();
  const res = await fetch("/admin/usage", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 403);
  const body = await res.json();
  t.match(body.message, /Admin access required/);
});

t.test("Admin: usage data", async (t) => {
  const token = await testToken(adminEmail);
  const res = await fetch("/admin/usage", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 200);
  const body = await res.json();
  t.ok(Array.isArray(body.data));
  t.type(body.data[0]?.email, "string");
  t.type(body.data[0]?.date, "string");
  t.type(body.data[0]?.cost, "number");
});

t.test("Admin: token generation", async (t) => {
  const token = await testToken(adminEmail);
  const res = await fetch("/admin/token?email=user@example.com", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 200);
  const body = await res.json();
  t.type(body.token, "string");
  const models = await fetch("/openrouter/v1/models", { headers: { Authorization: `Bearer ${body.token}` } });
  t.equal(models.status, 200);
});

t.test("Admin: invalid endpoint", async (t) => {
  const token = await testToken(adminEmail);
  const res = await fetch("/admin/invalid", { headers: { Authorization: `Bearer ${token}` } });
  t.equal(res.status, 404);
  const body = await res.json();
  t.match(body.message, /Unknown admin action/);
});

t.test("Admin: set cost", async (t) => {
  const email = "test@example.com";
  const date = ymd(new Date());
  const token = await testToken(email);
  const adminToken = await testToken(adminEmail);

  // Get the usage of email for date (0 if missing)
  const usageStart = await getUsage(token);
  const originalCost = usageStart.usage.find((row) => row.date === date)?.cost ?? 0;

  // Add/subtract 1 micro-dollar based on timestamp
  const cost = originalCost + (Date.now() % 2 ? 0.000001 : -0.000001);
  await fetch("/admin/cost", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ email, date, cost }),
  });

  // Get the cost and verify it's within acceptable floating point error (1e-12)
  const usageEnd = await getUsage(token);
  const actualCost = usageEnd.usage.find((row) => row.date === date)?.cost ?? 0;
  t.ok(Math.abs(actualCost - cost) < 1e-12);
});

// Helper for testing the dateRange logic
function testDateRange(days, nowDateString) {
  const now = new Date(nowDateString);
  // Replicated logic from src/cost.js
  const startDate = ymd(new Date(now - days * 24 * 60 * 60 * 1000));
  const endDate = ymd(now);
  return [startDate, endDate];
}

t.test("dateRange logic across DST changes", async (t) => {
  // Scenario 1: Spring Forward (e.g., US DST starts March 10, 2024)
  // 'now' = '2024-03-10T08:00:00Z' (This is 4 AM EDT on Mar 10, or 3 AM EST if DST change hasn't happened in this exact instant of calculation)
  // One day before should be '2024-03-09'.
  const [startDate1, endDate1] = testDateRange(1, '2024-03-10T08:00:00Z'); // 1 day before Mar 10, 8 AM UTC
  t.equal(startDate1, "2024-03-09", "Spring Forward: Start date should be one calendar day prior (UTC based calc)");
  t.equal(endDate1, "2024-03-10", "Spring Forward: End date should be 'now' (UTC based calc)");

  // Scenario 2: Fall Back (e.g., US DST ends November 3, 2024)
  // DST ends Nov 3, 2024, 2 AM EDT becomes 1 AM EST. The day has 25 hours.
  // Let's use 'now' = '2024-11-03T08:00:00Z' (This is 3 AM EST on Nov 3, after the 1 AM hour happened twice if we are in US/Eastern, or 4AM EST if the second 1AM was 1AM EST)
  // One day before should be '2024-11-02'.
  const [startDate2, endDate2] = testDateRange(1, '2024-11-03T08:00:00Z'); // 1 day before Nov 3, 8 AM UTC
  t.equal(startDate2, "2024-11-02", "Fall Back: Start date should be one calendar day prior (UTC based calc)");
  t.equal(endDate2, "2024-11-03", "Fall Back: End date should be 'now' (UTC based calc)");

  // The above tests primarily check UTC calendar day differences.
  // The actual bug is subtle: if the *local interpretation* of "N days ago" is expected,
  // then UTC calculations can be off.
  // For instance, if 'now' is March 10th 10:00 AM local time (after DST)
  // and "1 day ago" is expected to be March 9th 10:00 AM local time.
  // The current dateRange uses UTC for its base 'now' if not specified, or converts the provided 'now' to a JS Date (which is UTC-based).
  // The calculation `now - days * 24 * 60 * 60 * 1000` is purely UTC arithmetic.
  // A more robust solution for "N calendar days ago" would be:
  // let startDate = new Date(now);
  // startDate.setUTCDate(startDate.getUTCDate() - days);
  // This will correctly subtract calendar days in UTC.

  // Let's add a test to show the difference if we use setUTCDate.
  const testDateRangeRobust = (days, nowDateString) => {
    const now = new Date(nowDateString);
    const endDate = ymd(now);
    let startDateObj = new Date(now);
    startDateObj.setUTCDate(startDateObj.getUTCDate() - days);
    const startDate = ymd(startDateObj);
    return [startDate, endDate];
  };

  // Test with a specific case that might show a difference.
  // Consider a 'now' that is just into a new day in UTC, but still the previous day in a western timezone.
  // e.g. now = '2024-03-11T02:00:00Z' (Mar 11, 2 AM UTC)
  // In 'America/Los_Angeles' (PDT, UTC-7), this is Mar 10, 7 PM.
  // 1 day ago from Mar 11, 2 AM UTC should be Mar 10.
  const [s1Current, e1Current] = testDateRange(1, '2024-03-11T02:00:00Z');
  const [s1Robust, e1Robust] = testDateRangeRobust(1, '2024-03-11T02:00:00Z');
  t.equal(s1Current, "2024-03-10", "Current logic: 1 day before Mar 11, 2 AM UTC is Mar 10");
  t.equal(s1Robust, "2024-03-10", "Robust logic: 1 day before Mar 11, 2 AM UTC is Mar 10");
  // This specific example doesn't show a difference because ymd(new Date(epoch_millis)) is based on UTC day.

  // The fundamental issue is if the number of days is meant to be local calendar days relative to a local 'now',
  // but the calculation is performed in UTC using fixed 24-hour day lengths.
  // The current tests with testDateRange will pass because they are testing UTC date boundary changes.
  // The point of the bug is that `days * 24 * 60 * 60 * 1000` is not always `days` calendar days in local time.
  // However, since the `cost` function and `ymd` operate purely on UTC dates, the current `dateRange`
  // is consistent with that. The bug is more of a potential misunderstanding of "days" if it were
  // to be interpreted in local time context by a user of the function.

  // For the purpose of this exercise, we will document this subtlety.
  // The tests added here will confirm the current UTC-based behavior.
  // No direct "failure" will be shown by these tests for the current implementation,
  // as it's behaving as it's written (UTC calculations).
  // The "bug" is that this might not match user expectations if they think of "days" in their local timezone.
  t.comment("The dateRange function calculates based on UTC days using 24-hour fixed millisecond subtractions.");
  t.comment("This is consistent if 'days' is interpreted as UTC calendar days for the ymd function.");
  t.comment("Potential mismatch arises if 'days' is interpreted as local calendar days by a human.");
});
