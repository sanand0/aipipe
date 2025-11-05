// @ts-check
import { env, fetchMock, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll } from "vitest";
import { budget, salt } from "../src/config.example.js";
import { createToken } from "../src/utils.js";

export const TEST_EMAIL = "test@example.com";
export const ADMIN_EMAIL = "admin@example.com";

export const workerFetch = (path, init) => SELF.fetch(`https://example.com${path}`, init);

export const setupWorkerFetchMock = () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  afterAll(() => {
    fetchMock.assertNoPendingInterceptors();
    fetchMock.enableNetConnect();
    fetchMock.deactivate();
  });

  return fetchMock;
};

export const replyJson = (
  mock,
  { origin, path, method = "GET", status = 200, body = {}, headers = {}, persist, assertRequest } = {},
) => {
  const methodUpper = method.toUpperCase();
  const methodLower = methodUpper.toLowerCase();
  const poolFactory = mock[methodLower] ?? mock.get;
  if (!poolFactory) throw new Error(`Unsupported method for fetch mock: ${method}`);
  const pool = poolFactory.call(mock, origin);
  const interceptor = pool.intercept({ path, method: methodUpper });
  const normalizedHeaders = Object.fromEntries(
    Object.entries({ "content-type": "application/json", ...headers }).map((
      [key, value],
    ) => [key.toLowerCase(), value]),
  );
  const responseBody = typeof body === "string" ? body : JSON.stringify(body);
  const reply = assertRequest
    ? interceptor.reply((opts) => {
      assertRequest(opts);
      return { statusCode: status, data: responseBody, responseOptions: { headers: normalizedHeaders } };
    })
    : interceptor.reply(status, responseBody, { headers: normalizedHeaders });
  if (persist) reply.persist();
  return reply;
};

export const replyStream = (
  mock,
  { origin, path, method = "GET", events, status = 200, headers = {}, assertRequest },
) => {
  const methodUpper = method.toUpperCase();
  const poolFactory = mock[methodUpper.toLowerCase()] ?? mock.get;
  const pool = poolFactory.call(mock, origin);
  const interceptor = pool.intercept({ path, method: methodUpper });
  const body = `${events.join("\n\n")}\n\n`;
  const normalizedHeaders = Object.fromEntries(
    Object.entries({ "content-type": "text/event-stream", ...headers }).map((
      [key, value],
    ) => [key.toLowerCase(), value]),
  );
  if (assertRequest) {
    interceptor.reply((opts) => {
      assertRequest(opts);
      return { statusCode: status, data: body, responseOptions: { headers: normalizedHeaders } };
    });
  } else {
    interceptor.reply(status, body, { headers: normalizedHeaders });
  }
};

export const createTestToken = async (email = TEST_EMAIL, { useSalt = false, overrides = {} } = {}) => {
  const tokenOptions = { ...overrides };
  const salted = useSalt ? salt[email] : undefined;
  if (salted) tokenOptions.salt = salted;
  return createToken(email, env.AIPIPE_SECRET, tokenOptions);
};

export const seedUsage = async (entries = {}) => {
  const id = env.AIPIPE_COST.idFromName("default");
  const stub = env.AIPIPE_COST.get(id);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.sql.exec("DELETE FROM cost");
    for (const [email, dates] of Object.entries(entries)) {
      for (const [date, cost] of Object.entries(dates)) {
        await state.storage.sql.exec(
          "INSERT OR REPLACE INTO cost (email, date, cost) VALUES (?, ?, ?)",
          email,
          date,
          Number(cost),
        );
      }
    }
  });
};

export const readUsage = async (token) => {
  const response = await workerFetch("/usage", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json();
};

export const getBudgetForEmail = (email) => {
  const domain = `@${email.split("@").at(-1)}`;
  return budget[email] ?? budget[domain] ?? budget["*"] ?? { limit: 0, days: 1 };
};
