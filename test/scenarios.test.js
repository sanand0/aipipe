import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { providers } from "../src/providers.js";
import { loadJSONFixture, loadResponseFixture, registerMockFromFixture, seedDurableUsage } from "./fixtures/index.js";
import { setupMockLifecycle } from "./helpers/mock-lifecycle.js";
import { assertScenarioExpectations, runScenario } from "./helpers/scenario-runner.js";

const fetchMock = setupMockLifecycle();

const getUsage = async (token) => {
  const res = await SELF.fetch("https://example.com/usage", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
};

const usageHooks = ({ beforeEach, afterEach, directCost } = {}) => ({
  before: async (args) => {
    if (beforeEach) await beforeEach(args);
    await seedDurableUsage(env.AIPIPE_COST, runInDurableObject, {});
    if (args.scenario.expect?.usageDelta === undefined) return;
    args.context.beforeUsage = await getUsage(args.replacements.token);
  },
  after: async (args) => {
    const { scenario, response } = args;
    const clone = response.clone();
    await assertScenarioExpectations(scenario.expect, clone);

    const contentType = response.headers.get("content-type") ?? "";
    let parsedBody;
    if (contentType.includes("application/json")) {
      parsedBody = await response.clone().json();
    }
    if (contentType.includes("text/event-stream")) {
      await response.text();
    }
    if (afterEach) await afterEach({ ...args, contentType, parsedBody });

    if (scenario.expect?.usageDelta === undefined) return;
    if (parsedBody && directCost) {
      const direct = await directCost(parsedBody, args);
      expect(direct).toBeCloseTo(scenario.expect.usageDelta, 10);
    }
    const afterUsage = await getUsage(args.replacements.token);
    const beforeCost = args.context.beforeUsage?.cost ?? 0;
    expect(afterUsage.cost - beforeCost).toBeCloseTo(scenario.expect.usageDelta, 10);
  },
});

let modelsMockRegistered = false;

const ensureModelsMock = async () => {
  if (modelsMockRegistered) return;
  const response = await loadResponseFixture("openrouter-success.json");
  await registerMockFromFixture(fetchMock, {
    mock: {
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      response,
      persist: true,
    },
  });
  modelsMockRegistered = true;
};

const suites = [
  {
    title: "Gemini endpoints",
    scenarios: await loadJSONFixture("gemini.scenarios.json"),
    hooks: usageHooks(),
  },
  {
    title: "OpenAI /v1 endpoints",
    scenarios: await loadJSONFixture("openai.scenarios.json"),
    hooks: usageHooks({
      directCost: async (parsed) => (await providers.openai.cost(parsed)).cost,
    }),
  },
  {
    title: "Similarity endpoint",
    scenarios: await loadJSONFixture("similarity.scenarios.json"),
    hooks: usageHooks({
      afterEach: ({ parsedBody }) => {
        if (!parsedBody) return;
        expect(Array.isArray(parsedBody.similarity)).toBe(true);
      },
      directCost: async (parsed) =>
        (await providers.openai.cost({ model: parsed.model, usage: { prompt_tokens: 8 } })).cost,
    }),
  },
  {
    title: "OpenRouter /v1/models scenarios from tap suite",
    scenarios: await loadJSONFixture("openrouter-models.scenarios.json"),
    hooks: {
      after: async ({ scenario, response }) => {
        await assertScenarioExpectations(scenario.expect, response.clone());
      },
    },
  },
  {
    title: "OpenRouter /v1/chat/completions",
    scenarios: await loadJSONFixture("openrouter-chat.scenarios.json"),
    hooks: usageHooks({
      beforeEach: () => ensureModelsMock(),
      directCost: async (parsed) =>
        (await providers.openrouter.cost({ model: parsed.model, usage: parsed.usage })).cost,
    }),
  },
];

for (const { title, scenarios, hooks } of suites) {
  describe(title, () => {
    for (const scenario of scenarios) {
      test(scenario.name, async () => {
        await runScenario({
          scenario,
          fetchMock,
          before: hooks?.before,
          after: hooks?.after,
        });
      });
    }
  });
}
