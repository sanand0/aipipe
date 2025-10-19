import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { budget, salt } from "../src/config.example.js";
import { createToken } from "../src/utils.js";
import { loadStateFixture, seedDurableUsage } from "./fixtures/index.js";
import { setupMockLifecycle } from "./helpers/mock-lifecycle.js";
import { assertScenarioExpectations, runScenario } from "./helpers/scenario-runner.js";

const fetchMock = setupMockLifecycle();
const TEST_SECRET = env.AIPIPE_SECRET;

const callWorker = (path, init) => SELF.fetch(`https://example.com${path}`, init);

const createTestToken = (email = "test@example.com", tokenSalt) =>
  createToken(email, TEST_SECRET, tokenSalt ? { salt: tokenSalt } : {});

const sumStateForEmail = (state, email) =>
  Object.values(state[email] ?? {}).reduce((total, value) => total + Number(value), 0);

test("GET /openrouter/v1/models responds with CORS headers", async () => {
  const scenario = {
    request: "openrouter-unauthorized",
    expect: {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-expose-headers": "*",
      },
    },
  };
  const { response } = await runScenario({ scenario, fetchMock });
  await assertScenarioExpectations(scenario.expect, response.clone());
});

test("README Authorization examples include Bearer prefix", async () => {
  const readmeModule = await import("../README.md?raw");
  const readme = readmeModule.default ?? readmeModule;
  expect(readme).toContain("Authorization: Bearer");
  const invalidAuthorizations = [...readme.matchAll(/Authorization:\s*([^\n]+)/g)].filter(
    ([, header]) => !/Bearer\s+/i.test(header),
  );
  expect(invalidAuthorizations).toEqual([]);
});

test("CORS allows requested headers", async () => {
  const requestedHeaders = "X-Custom-Header";
  const response = await callWorker("/openrouter/v1/models", {
    method: "OPTIONS",
    headers: { "Access-Control-Request-Headers": requestedHeaders },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
  expect(response.headers.get("access-control-max-age")).toBe("86400");
  expect(response.headers.get("access-control-allow-headers")).toBe(requestedHeaders);
});

test("Authorization required", async () => {
  const scenario = {
    request: "openrouter-missing-auth",
    expect: {
      status: 401,
      body: { messageIncludes: "Missing Authorization" },
    },
  };
  const { response } = await runScenario({ scenario, fetchMock });
  await assertScenarioExpectations(scenario.expect, response.clone());
});

test("Invalid JWT token", async () => {
  const scenario = {
    request: "openrouter-unauthorized",
    expect: {
      status: 401,
      body: { messageIncludes: "invalid" },
    },
  };
  const { response } = await runScenario({ scenario, fetchMock });
  await assertScenarioExpectations(scenario.expect, response.clone());
});

test("Valid JWT token", async () => {
  const scenario = {
    request: "openrouter-success",
    token: { email: "test@example.com" },
    expect: {
      status: 200,
      body: { responseFixture: "openrouter-success.json" },
    },
  };
  const { response } = await runScenario({ scenario, fetchMock });
  await assertScenarioExpectations(scenario.expect, response.clone());
});

test("Invalid provider", async () => {
  const token = await createTestToken();
  const response = await callWorker("/invalid-provider/", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.message).toMatch(/Unknown provider/);
});

test("Invalid salt", async () => {
  const [email] = Object.keys(salt);
  const token = await createTestToken(email);
  const response = await callWorker("/openrouter/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body.message).toMatch(/no longer valid/i);
});

test("Valid salt", async () => {
  const [email] = Object.entries(salt)[0];
  const scenario = {
    request: "openrouter-success",
    token: { email, useSalt: true },
    expect: {
      status: 200,
      body: { responseFixture: "openrouter-success.json" },
    },
  };
  const { response } = await runScenario({ scenario, fetchMock });
  await assertScenarioExpectations(scenario.expect, response.clone());
});

test("Usage endpoint", async () => {
  const usageState = await loadStateFixture("durable-usage");
  const resolvedUsage = await seedDurableUsage(env.AIPIPE_COST, runInDurableObject, usageState);
  const token = await createTestToken();
  const response = await callWorker("/usage", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  const expectedCost = sumStateForEmail(resolvedUsage, "test@example.com");
  expect(body.cost).toBeCloseTo(expectedCost, 5);
  expect(Array.isArray(body.usage)).toBe(true);
});

test("Domain budget fallback", async () => {
  const email = "domain-user@example.com";
  const usageState = await loadStateFixture("durable-usage");
  const resolvedUsage = await seedDurableUsage(env.AIPIPE_COST, runInDurableObject, usageState);
  const token = await createTestToken(email);
  const response = await callWorker("/usage", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  expect(body.limit).toBe(budget["@example.com"].limit);
  expect(body.limit).not.toBe(budget["*"].limit);
  const expectedCost = sumStateForEmail(resolvedUsage, email);
  expect(body.cost).toBeCloseTo(expectedCost, 5);
});
