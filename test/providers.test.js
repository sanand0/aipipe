import t from "tap";
import { providers } from "../src/providers.js"; // Assuming providers.js exports this

// Mock global fetch
let fetchMock;
let originalFetch;
let fetchCallCount;
let mockResponses = {};

function setupFetchMock() {
  originalFetch = globalThis.fetch;
  fetchCallCount = 0;
  globalThis.fetch = async (url) => {
    fetchCallCount++;
    if (mockResponses[url]) {
      return mockResponses[url]();
    }
    return {
      ok: true,
      json: async () => ({ data: [] }), // Default empty model list
      text: async () => "mocked response",
    };
  };
}

function teardownFetchMock() {
  globalThis.fetch = originalFetch;
  mockResponses = {};
}

t.beforeEach(setupFetchMock);
t.afterEach(teardownFetchMock);

t.test("OpenRouter provider - getOpenrouterModel caching logic via cost function", async (t) => {
  // --- Scenario A: Initial fetch & cache population ---
  t.comment("Scenario A: Initial fetch & cache population");
  const modelsUrl = "https://openrouter.ai/api/v1/models";
  mockResponses[modelsUrl] = () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: "model-a", pricing: { prompt: 0.1, completion: 0.2, request: 0.01 } },
      ],
    }),
  });

  let costResult = await providers.openrouter.cost({
    model: "model-a",
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  });
  // Cost = (100 * 0.1) + (100 * 0.2) + 0.01 = 10 + 20 + 0.01 = 30.01
  t.equal(fetchCallCount, 1, "Fetch should be called once for initial model list");
  t.ok(Math.abs(costResult.cost - 30.01) < 1e-9, "Cost for model-a should be 30.01");

  // --- Scenario B: Uses cached data ---
  t.comment("Scenario B: Uses cached data");
  costResult = await providers.openrouter.cost({
    model: "model-a", // Same model
    usage: { prompt_tokens: 50, completion_tokens: 50 },
  });
  // Cost = (50 * 0.1) + (50 * 0.2) + 0.01 = 5 + 10 + 0.01 = 15.01
  t.equal(fetchCallCount, 1, "Fetch should NOT be called again (used cache)");
  t.ok(Math.abs(costResult.cost - 15.01) < 1e-9, "Cost for model-a (cached) should be 15.01");

  // --- Scenario C: Cache 'refresh' on unknown model, demonstrating staleness issue ---
  t.comment("Scenario C: Cache 'refresh' on unknown model");
  // New model list where model-a has new pricing
  mockResponses[modelsUrl] = () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: "model-a", pricing: { prompt: 0.5, completion: 0.5, request: 0.05 } }, // New pricing for model-a
        { id: "model-b", pricing: { prompt: 0.3, completion: 0.4, request: 0.02 } },
      ],
    }),
  });

  costResult = await providers.openrouter.cost({
    model: "model-b", // New, unknown model
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
  // Cost for model-b = (10 * 0.3) + (10 * 0.4) + 0.02 = 3 + 4 + 0.02 = 7.02
  t.equal(fetchCallCount, 2, "Fetch should be called again for new model list (model-b)");
  t.ok(Math.abs(costResult.cost - 7.02) < 1e-9, "Cost for model-b should be 7.02");

  // Now check model-a again, it should use the NEW pricing from the refreshed cache
  costResult = await providers.openrouter.cost({
    model: "model-a",
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
  // Cost for model-a (new pricing) = (10 * 0.5) + (10 * 0.5) + 0.05 = 5 + 5 + 0.05 = 10.05
  t.equal(fetchCallCount, 2, "Fetch should NOT be called again (model-a now in updated cache)");
  t.ok(Math.abs(costResult.cost - 10.05) < 1e-9, "Cost for model-a should use new pricing (10.05)");

  t.comment("This demonstrates that model-a's pricing was updated only because model-b (an unknown model) was queried.");
  t.comment("If model-b was never queried, model-a's pricing would have remained stale.");

  // --- Scenario D: Call without model name (testing the other identified issue) ---
  // This is harder to test for getOpenrouterModel directly via the cost function,
  // as 'cost' requires a model. If getOpenrouterModel was called with model=null,
  // it would return {} and pricing would be undefined, leading to cost 0.
  // The test for getOpenrouterModel(null) -> {} and no fetch would ideally be a direct unit test.
  // For now, we'll note this limitation in the BUGS.md.
  t.comment("Scenario D: Behavior of getOpenrouterModel when called without a model name is not directly tested here.");
});

// To run this test, you might need to update package.json test script
// e.g., "test": "tap test/test.js test/providers.test.js"
// Also, `src/providers.js` needs to have `export { providers };`
// The current `src/providers.js` has `export const providers = { ... }` which is fine.
