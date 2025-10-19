# Tests

This folder contains two kinds of automated checks:

- `test/test.js` &nbsp;— legacy TAP integration tests that hit a running Worker.
- `test/*.test.js` &nbsp;— Vitest suites that run entirely inside the Workers runtime with mocks.

The Vitest suites are safer and faster because every outbound provider call is stubbed with JSON fixtures. The steps below explain how to add a new mocked test.

## Adding a fixture-backed test

1. **Create a fixture**\
   Add `test/fixtures/<name>.json` with the HTTP method, path, headers, and optional body the Worker should see. Use `{{placeholders}}` for dynamic values like bearer tokens. If the Worker returns JSON, store the canonical response under a top-level `response` key so assertions can re-use it.

2. **Mock upstream responses (if needed)**\
   Provider calls live under a `mock` block. Inline the upstream response object under `mock.response`, or point to another fixture (for example `similarity-openai.response.json`) when multiple scenarios share the same payload. Always include a `Content-Type` header (`application/json` or `text/event-stream`) so the Worker knows how to process the response. For streaming endpoints, provide an `sse` array whose entries are literal SSE lines, for example:

   ```json
   {
     "status": 200,
     "headers": { "content-type": "text/event-stream" },
     "sse": ["data: {\"model\":\"gpt-5-nano\",\"choices\":[...]}", "data: [DONE]"]
   }
   ```

3. **Capture durable state (when applicable)**\
   If the scenario depends on existing usage data, describe it in `test/fixtures/durable-usage.state.json` using `{ "daysAgo": <number>, "cost": <amount> }` entries so the helper can generate fresh dates.

4. **Register the scenario**\
   Describe the new flow inside the relevant scenario list (for OpenRouter models, edit `test/fixtures/openrouter-models.scenarios.json`; for OpenAI endpoints, edit `test/fixtures/openai.scenarios.json`). Include the request fixture name, expected status/body, token details, and any expected cost delta.

5. **Let the shared test pick it up**\
   `test/scenarios.test.js` loads every scenario list and runs them through `runScenario({ scenario, fetchMock, before, after })`. Add suite-specific hooks there only when the helpers need extra assertions or setup (for example, seeding Durable Objects or computing cost deltas). If the provider streams (`text/event-stream`), consume the body (for example `await response.text()`) so the Worker processes every chunk before you read usage data.

6. **Run the suite**\
   Execute `npm run test:worker`. The script runs every `*.test.js` file under `test/`, so keep the consolidated runner green and verify no interceptors remain pending.

Following these steps ensures every test stays data-driven and avoids the stale-date, stale-cache, and un-consumed-mock issues we hit earlier. If you extend the helpers, document the new behaviour here so future additions remain straightforward.
