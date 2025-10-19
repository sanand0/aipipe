# Vitest Worker Test Plan

## Goals

- Exercise critical worker paths (authorization, provider proxying, usage tracking, admin tooling) with deterministic fixtures.
- Replace bespoke stubs with tooling that mirrors the Workers runtime, so Durable Object behaviour matches production.
- Make it simple to add new HTTP scenarios by dropping JSON files instead of hand-coding mocks.

## Current Test Gaps (`test/worker.test.js`)

- Relies on `MockAIPipeCost`, so behaviour can diverge from the real Durable Object (`src/cost.js`) and migrations defined in `wrangler.toml`.
- Global `fetch` stub returns minimal JSON; no coverage for streaming/SSE, non-JSON payloads, or provider-specific parsing.
- Authorization suite does not exercise `/proxy`, `/admin/*`, or budget exhaustion paths that call `AIPipeCost.add`.
- Token expiry and salt rotation scenarios only cover single-entry salts, not multi-user or domain-wide overrides.

## Durable Object Testing Options

| Option                                                         | Simplicity | Robustness | Notes                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Hand-written stub (status quo)**                          | ⭐⭐⭐⭐☆  | ⭐⭐☆☆☆    | Quick, Node-only. Risks API skew (no alarms, storage persistence, concurrency). Hard to share with other suites.                                                                                                                                                                                                                 |
| **B. Workers Vitest pool (`@cloudflare/vitest-pool-workers`)** | ⭐⭐⭐☆    | ⭐⭐⭐⭐⭐ | Cloudflare’s recommended path; tests run inside `workerd`, exposing `cloudflare:test` helpers such as `runInDurableObject`, `listDurableObjectIds`, and an in-memory Durable Object implementation with isolated storage[^cf-vitest]. Example projects show direct Durable Object introspection and alarm control[^cf-examples]. |
| **C. Low-level Miniflare harness**                             | ⭐⭐☆☆     | ⭐⭐⭐⭐☆  | Runs real Durable Objects via Miniflare APIs (`dispatchFetch`, `getBindings`)[^miniflare]. More setup (build scripts, manual binding config) and tests execute in Node rather than `workerd`. Useful if you need a custom runner or already depend on TAP.                                                                       |

[^cf-vitest]: [Workers Vitest integration documentation](https://developers.cloudflare.com/workers/testing/vitest-integration/) and [`cloudflare:test` reference](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).

[^cf-examples]: [Cloudflare durable-objects Vitest example](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-pool-workers-examples/durable-objects) demonstrating `runInDurableObject`, `listDurableObjectIds`, and alarm execution.

[^miniflare]: [Miniflare “Writing tests” guide](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/) covering bindings access and Durable Object simulation.

### Recommendation

Adopt **Option B**:

1. `npm i -D @cloudflare/vitest-pool-workers` (or add via existing package manager).
2. Add `vitest.config.ts` with Cloudflare pool:

   ```ts
   import cf from "@cloudflare/vitest-pool-workers/config";
   import { defineConfig } from "vitest/config";

   export default defineConfig({
     test: {
       pool: cf,
       environment: "cloudflare",
       poolOptions: {
         workers: {
           isolatedStorage: true,
         },
       },
     },
   });
   ```

3. Move worker tests to run under the pool (e.g. `vitest run` instead of `node --experimental-vm-modules`).
4. Replace `MockAIPipeCost` with real `env.AIPIPE_COST` stubs:

   ```ts
   import { env, runInDurableObject, SELF } from "cloudflare:test";

   test("usage endpoint returns Durable Object data", async () => {
     const id = env.AIPIPE_COST.idFromName("default");
     const stub = env.AIPIPE_COST.get(id);
     await runInDurableObject(stub, (_, state) => state.storage.put("2025-01-01:test@example.com", 42));

     const response = await SELF.fetch("https://example.com/usage", {
       headers: { Authorization: `Bearer ${await createTestToken()}` },
     });
     expect(await response.json()).toMatchObject({ cost: 42 });
   });
   ```

5. Use `listDurableObjectIds` and `runDurableObjectAlarm` to validate migrations, alarm scheduling, and leak-free isolation across tests.

This approach keeps test semantics close to production, picks up runtime upgrades automatically, and leverages Cloudflare-maintained helpers for request mocking (`fetchMock`), queue batching, etc.

## Additional Test Enhancements

- **Auth edge cases**: Add fixtures for malformed Authorization headers, expired JWTs, salt rotation (user, domain, wildcard), and admin-only routes.
- **Provider coverage**: Exercise `/proxy`, `/similarity`, and SSE pathways by asserting cost accumulation and header rewriting. Use Worker pool’s streaming support to pipe mock SSE payloads.
- **Cost enforcement**: Seed Durable Object storage via `runInDurableObject` to simulate prior usage and assert 429 responses with accurate message formatting.
- **Regression harness**: Leverage `isolatedStorage` to keep tests independent and run in parallel.

## JSON Fixture Portfolio

### Directory Layout

```
test/
  fixtures/
    requests/
      openrouter-success.json
      openrouter-unauthorized.json
      proxy-timeout.json
    responses/
      openrouter-success.json
      similarity-stream.ndjson
    states/
      durable-usage.json
```

### JSON Schema Guidelines

- **Request fixture** (`test/fixtures/requests/*.json`):
  ```json
  {
    "description": "OpenRouter happy path",
    "request": {
      "method": "GET",
      "path": "/openrouter/v1/models",
      "headers": {
        "Authorization": "Bearer {{token}}"
      },
      "body": null
    },
    "env": {
      "AIPIPE_SECRET": "test-secret",
      "ADMIN_EMAILS": "admin@example.com"
    },
    "durableSeed": "durable-usage.json"
  }
  ```
- **Response fixture** (`test/fixtures/responses/*.json` or `.ndjson` for streams):
  ```json
  {
    "status": 200,
    "headers": {
      "Content-Type": "application/json"
    },
    "body": {
      "data": [
        {
          "id": "google/gemini-2.5-flash-lite",
          "pricing": { "prompt": 1e-5, "completion": 2e-5 }
        }
      ]
    }
  }
  ```
- **Durable Object seed** (`test/fixtures/states/durable-usage.json`):
  ```json
  {
    "emails": {
      "test@example.com": {
        "2025-01-01": 25.0
      }
    }
  }
  ```

### Helper Utilities

1. Create a `test/utils/fixtures.js` module:

   ```js
   import { readFile } from "node:fs/promises";
   import { join } from "node:path";

   const FIXTURE_ROOT = new URL("../fixtures/", import.meta.url);

   export async function loadScenario(name) {
     const spec = JSON.parse(await readFile(new URL(`requests/${name}.json`, FIXTURE_ROOT)));
     let response;
     try {
       response = JSON.parse(await readFile(new URL(`responses/${name}.json`, FIXTURE_ROOT)));
     } catch {
       response = null;
     }
     return { spec, response };
   }
   ```

2. In tests, hydrate Durable Object state before hitting the Worker:

   ```ts
   import { env, runInDurableObject, SELF } from "cloudflare:test";
   import { loadScenario, seedDurableObject } from "./utils/fixtures.js";

   test("enforces usage limit", async () => {
     const { spec } = await loadScenario("limit-reached");
     await seedDurableObject(env.AIPIPE_COST, spec.durableSeed);
     const response = await SELF.fetch(`https://example.com${spec.request.path}`, {
       method: spec.request.method,
       headers: { Authorization: `Bearer ${await createTestToken()}` },
     });
     expect(response.status).toBe(429);
   });
   ```

3. Extend the fetch mock (if needed) to stream canned responses:

   ```ts
   import { fetchMock } from "cloudflare:test";

   beforeAll(() => {
     fetchMock.activate();
     fetchMock.disableNetConnect();
   });
   ```

   ```ts
   setupScenario("openrouter-success", ({ response }) => {
     fetchMock
       .get("https://openrouter.ai")
       .intercept({ path: "/api/v1/models" })
       .reply(response.status, response.body, response.headers);
   });
   ```

4. Document naming conventions in `test/fixtures/README.md` so contributors can add new scenarios quickly.

### Benefits

- **Simplicity**: Adding a new provider regression means dropping JSON files and reusing helpers.
- **Robustness**: Fixtures double as living documentation of supported upstream payloads and prevent regressions when providers change their schema.
- **Extensibility**: `durableSeed` files allow reuse across multiple request fixtures, ensuring the Durable Object remains the single source of truth for quota logic.

## Next Steps

1. Introduce the Vitest pool configuration and migrate existing tests off the manual Durable Object stub.
2. Set up fixture utilities and port current assertions to load from JSON.
3. Backfill high-value scenarios (usage limit, admin token issuance, proxy error handling, SSE cost accounting).
4. Add CI job (e.g. `npm run test -- --runInBand`) to execute the Cloudflare-pooled Vitest suite alongside existing TAP tests.

# Refactor with Workers Vitest pool

- Added Workers pool wiring via `defineWorkersConfig` in `vitest.config.js`, configuring `wrangler.toml`, shared secrets, and `isolatedStorage`. Initial attempt (`pool: cf`, custom `environment`) surfaced missing package errors; resolved by installing `@cloudflare/vitest-pool-workers`, switching to `defineWorkersConfig`, and letting the integration supply the runtime.
- Replaced the bespoke `MockAIPipeCost` shim with production bindings exposed by `cloudflare:test`. `test/worker.test.js` now drives requests through `SELF.fetch`, reads the secret from `env`, and stubs outbound OpenRouter traffic with `fetchMock`. Converted the README assertion to `import("../README.md?raw")` because synchronous `fs` reads are unavailable inside `workerd`.
- Test run issues & fixes:

1. `@cloudflare/vitest-pool-workers` missing → installed locally with `npm install --save-dev @cloudflare/vitest-pool-workers`.
2. `vitest-environment-cloudflare` resolution failure → removed the explicit `environment` setting after adopting `defineWorkersConfig`.
3. Compatibility flag error → pointed the pool at `wrangler.toml` (`poolOptions.workers.wrangler.configPath`) so the configured `compatibility_date` is respected.
4. `readFileSync` unavailable in Workers → replaced with Vite’s `?raw` file import.

- Validated the migration with `npm run test:worker` (11 tests executing inside the Workers runtime with mocked outbound requests).

# Refactor with JSON request/response fixtures

- Followed Vite/Vitest fixture guidance to keep HTTP interactions in dedicated JSON artifacts so tests stay declarative and repeatable, allowing helpers to hydrate requests, mock upstream services, and encode assertions outside the test body.
- Added `test/fixtures/*.json` for OpenRouter success/unauthorized scenarios and Durable Object state, plus `test/fixtures/index.js` helpers to load fixtures, substitute placeholders, register mocks, and seed storage through `runInDurableObject`.
- Updated `test/worker.test.js` to consume fixtures via `callFromFixture`, removing inline mock payloads and asserting responses against fixture data; usage/domain tests now seed durable state from JSON and validate totals.
- Errors & fixes:

1. Dynamic import without static extension raised Vite error → replaced ad-hoc `import()` with `import.meta.glob("./*.json", { query: "?raw", import: "default" })`.
2. Seeded dates fell outside the 7-day budget window so usage stayed zero → reworked `durable-usage.state.json` to express costs via relative `daysAgo` offsets. Added `resolveUsageState()` so tests and seeding share a single code path that materializes current-day timestamps, keeping fixtures evergreen.

- Test run: `npm run test:worker` (11 passing in ~2.5s) confirming fixture-driven suite.

# Add basic tests

- Documented a repeatable workflow in `test/README.md` so new mocked tests start with fixtures (`*.request.json`/`*.response.json`), optional durable state, scenario registration, and `npm run test:worker` for validation.
- Added request fixtures for OpenRouter model flows (`openrouter-options*.request.json`, `openrouter-missing-auth.request.json`, `openrouter-invalid-salt.request.json`, `openrouter-budget-blocked.request.json`) plus consolidated expectations in `test/fixtures/openrouter-models.scenarios.json`.
- Created `test/openrouter.models.test.js` to iterate over those scenarios with `fetchMock` and fixture helpers, covering every `/openrouter/v1/models` check previously implemented in `test/test.js`.
- Updated `package.json` so `npm run test:worker` runs the entire Vitest suite, then executed it to verify both `worker.test.js` and the new OpenRouter scenarios pass (19 tests total).
- Encountered Vitest’s “No test files found” error when the script targeted a glob literal; resolved by switching the script to bare `vitest run` and noting the naming requirement in `test/README.md`.

# Add OpenAI tests

- Added OpenAI request/response fixtures (`openai-*.request.json`, `openai-*.response.json`) and registered scenarios in `test/fixtures/openai.scenarios.json`, including expected cost deltas to mirror the TAP suite assertions.
- Enhanced `test/fixtures/index.js` so mocks can emit SSE payloads and pass headers via the Undici `{ headers }` reply options, ensuring `Content-Type` survives and cost accounting triggers.
- Implemented `test/openai.test.js` to iterate scenarios: seeding Durable Object state, dispatching fixture-driven requests, draining SSE responses, and asserting both API payloads and cost accumulation.
- Updated `test/README.md` with notes on declaring `Content-Type`, supplying `sse` arrays, and consuming streaming bodies—preventing the missing-header/missed-cost issues encountered during development.
- Errors & fixes:

1. Initial mocks omitted `Content-Type`, so the Worker skipped cost tracking → normalized headers and used Undici’s `{ headers }` signature.
2. Streaming tests attempted to parse SSE responses as JSON → gated direct-cost assertions on `application/json` responses and explicitly read SSE bodies to flush accounting.

- Test run: `npm run test:worker` (22 passing) covering Worker, OpenRouter, and OpenAI suites.

# Refactor tests

- Extracted common Vitest utilities: `test/helpers/mock-lifecycle.js` centralises `fetchMock` activation/cleanup, while `test/helpers/scenario-runner.js` handles token generation, fixture registration (including multiple outbound mocks), and expectation assertions.
- Updated `test/worker.test.js`, `test/openrouter.models.test.js`, and `test/openai.test.js` to reuse those helpers instead of bespoke request logic, eliminating duplicated setup/teardown code.
- Added OpenRouter chat completion coverage (`test/openrouter.chat.test.js`) with fixtures for non-streaming and streaming flows, including SSE payloads and pricing expectations; ensured cost deltas persist via Durable Objects.
- Expanded fixture helper support for arrays of mocks, SSE bodies, and optional persistence so complex scenarios (pricing lookups + streaming) remain deterministic.
- Documentation refresh: `test/README.md` now walks through the shared helpers, SSE fixtures, and streaming consumption requirements to prevent stale mocks and missing cost updates.
- Regression proof: `npm run test:worker` now executes 24 passing tests spanning worker basics, OpenRouter models/chat, and OpenAI endpoints.

# Cover remaining tests

- Added Gemini fixtures (`gemini-*.request/response.json`, `gemini.scenarios.json`) and `test/gemini.test.js` to mirror TAP coverage for generative completions (streaming and non-streaming) and embeddings, asserting Durable Object cost deltas for each flow.
- Implemented OpenRouter chat completion scenarios in `test/openrouter.chat.test.js`, using shared helpers to drain SSE streams and validate pricing.
- Ported the `/similarity` test into `test/similarity.test.js` with fixtures stubbing the intermediate OpenAI embeddings call, verifying the similarity matrix and cost accumulation.
- Enhanced `registerMockFromFixture()` to support arrays of outbound mocks, persistent interceptors, and optional replay counts so multi-request scenarios (e.g., model lookups plus completions) stay deterministic.
- Updated `package.json` to run Vitest with `WRANGLER_LOG=none`, avoiding sandbox log-write failures, and refreshed `test/README.md` with guidance on using the helper modules and streaming fixtures.
- Full suite: `npm run test:worker` now exercises 28 fixture-backed tests covering OpenRouter models/chat, OpenAI endpoints, Gemini APIs, Similarity, and core worker behaviour.

# Shorten tests

- Changes made: collapsed provider scenario files into `test/scenarios.test.js`, merged request/response fixtures into single `test/fixtures/<name>.json`, refreshed helpers to load combined fixtures, and rewrote `test/README.md` to describe the new layout.
- Errors & fixes:
  1. Initial `npm run test:worker` left pending interceptors because the new suite loaded `openrouter-success.json` while the OpenRouter chat helper also registered a persistent `/models` mock. Removed duplicate mocks by reintroducing `ensureModelsMock()` with a shared interceptor and running the models suite before the chat suite.
  2. Second run failed after marking the fixture mock as `persist: true`, which propagated unused interceptors into `worker.test.js`. Reverted the fixture flag, dropped per-scenario registration, and kept a single persistent interceptor that mirrors the original file-level behaviour.
  3. A final attempt that registered non-persistent intercepts per scenario still saw uninvoked `/models` mocks. Restored the persistent helper and reordered suites so the persistent mock appears only after the fixture-driven models tests complete.
- Test run: `npm run test:worker` (28 passing in ~3.5s) confirming the consolidated suite and merged fixtures.
