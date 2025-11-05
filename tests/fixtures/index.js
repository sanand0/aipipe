// @ts-check
const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;
const DAY_MS = 24 * 60 * 60 * 1000;

const RAW_FIXTURES = import.meta.glob("./*.json", { query: "?raw", import: "default" });

const hasFixture = (filename) => Boolean(RAW_FIXTURES[`./${filename}`]);

async function loadRawFixture(filename) {
  const loader = RAW_FIXTURES[`./${filename}`];
  if (!loader) throw new Error(`Unknown fixture: ${filename}`);
  return loader();
}

export async function loadJSONFixture(filename) {
  return JSON.parse(await loadRawFixture(filename));
}

export async function loadRequestFixture(name) {
  const candidates = name.endsWith(".json") ? [name] : [`${name}.json`, `${name}.request.json`];
  for (const filename of candidates) {
    if (hasFixture(filename)) return loadJSONFixture(filename);
  }
  throw new Error(`Unknown request fixture: ${name}`);
}

export async function loadResponseFixture(name) {
  const candidates = name.endsWith(".json") ? [name] : [`${name}.json`, `${name}.response.json`];
  for (const filename of candidates) {
    if (!hasFixture(filename)) continue;
    const fixture = await loadJSONFixture(filename);
    return fixture.response ?? fixture;
  }
  throw new Error(`Unknown response fixture: ${name}`);
}

export async function loadStateFixture(name) {
  return loadJSONFixture(`${name}.state.json`);
}

export function applyPlaceholders(value, replacements) {
  if (!value || !replacements) return value;
  if (typeof value === "string") {
    return value.replaceAll(PLACEHOLDER_PATTERN, (_, key) => {
      if (!(key in replacements)) return `{{${key}}}`;
      return replacements[key];
    });
  }
  if (Array.isArray(value)) return value.map((item) => applyPlaceholders(item, replacements));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, applyPlaceholders(val, replacements)]));
  }
  return value;
}

export function buildRequestInit(requestFixture, replacements = {}) {
  const { method = "GET", headers = {}, body } = requestFixture;
  const resolvedHeaders = applyPlaceholders(headers, replacements);
  const init = { method, headers: resolvedHeaders };
  if (body !== undefined && body !== null) {
    init.body = typeof body === "string" ? applyPlaceholders(body, replacements) : JSON.stringify(body);
  }
  return init;
}

export async function registerMockFromFixture(fetchMock, requestFixture, replacements = {}) {
  if (!requestFixture.mock) return;
  const mocks = Array.isArray(requestFixture.mock) ? requestFixture.mock : [requestFixture.mock];

  for (const mock of mocks.filter(Boolean)) {
    const origin = mock.origin;
    const method = (mock.method ?? "GET").toUpperCase();
    const methodLower = method.toLowerCase();
    const responseFixture = typeof mock.response === "string"
      ? await loadJSONFixture(mock.response)
      : structuredClone(mock.response);
    const resolvedResponse = applyPlaceholders(responseFixture, replacements);

    const headers = { ...resolvedResponse.headers };
    let body;
    if (Array.isArray(resolvedResponse.sse)) {
      const ssePayload = resolvedResponse.sse.join("\n\n");
      body = ssePayload.endsWith("\n\n") ? ssePayload : `${ssePayload}\n\n`;
      headers["Content-Type"] ??= "text/event-stream";
    } else if (typeof resolvedResponse.body === "string") {
      body = resolvedResponse.body;
    } else if (resolvedResponse.body !== undefined) {
      body = JSON.stringify(resolvedResponse.body ?? {});
    } else {
      body = "";
    }

    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );

    const status = resolvedResponse.status ?? 200;

    const poolFactory = fetchMock[methodLower] ?? fetchMock.get;
    if (!poolFactory) throw new Error(`Unsupported mock method: ${mock.method}`);
    const pool = poolFactory.call(fetchMock, origin);
    const interceptor = pool.intercept({ path: mock.path, method });
    const reply = interceptor.reply(status, body, { headers: normalizedHeaders });
    if (mock.persist) reply.persist();
    if (mock.times) reply.times(mock.times);
  }
}

function normalizeUsageEntries(entries) {
  if (Array.isArray(entries)) return entries;
  if (entries && typeof entries === "object") {
    return Object.entries(entries).map(([date, cost]) => ({ date, cost }));
  }
  return [];
}

function formatDateUTC(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveUsageState(stateData, referenceDate = new Date()) {
  const resolved = {};
  for (const [email, entries] of Object.entries(stateData ?? {})) {
    for (const entry of normalizeUsageEntries(entries)) {
      const cost = Number(entry.cost ?? 0);
      if (Number.isNaN(cost)) continue;

      const daysAgo = Number(entry.daysAgo ?? 0);
      const offsetDate = new Date(referenceDate.getTime() - daysAgo * DAY_MS);
      const date = entry.date ?? formatDateUTC(offsetDate);

      resolved[email] ??= {};
      resolved[email][date] = (resolved[email][date] ?? 0) + cost;
    }
  }
  return resolved;
}

export async function seedDurableUsage(namespace, runInDurableObject, stateData, referenceDate = new Date()) {
  if (!stateData) return {};
  const resolved = resolveUsageState(stateData, referenceDate);
  const id = namespace.idFromName("default");
  const stub = namespace.get(id);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.sql.exec("DELETE FROM cost");
    for (const [email, dates] of Object.entries(resolved)) {
      for (const [date, cost] of Object.entries(dates)) {
        await state.storage.sql.exec(
          "INSERT OR REPLACE INTO cost (email, date, cost) VALUES (?, ?, ?)",
          email,
          date,
          cost,
        );
      }
    }
  });
  return resolved;
}
