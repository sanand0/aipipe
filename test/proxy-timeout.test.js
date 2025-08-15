import t from "tap";
import { Agent } from "undici";

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";

async function fetch(path, params = {}) {
  const url = `${BASE_URL}${path}`;
  return await globalThis.fetch(url, params);
}

// Test timeout - using a URL that will definitely timeout
// Use a dedicated agent so sockets close promptly
const agent = new Agent({ keepAliveTimeout: 0, keepAliveMaxTimeout: 0 });

t.test("Proxy API timeout", async (t) => {
  t.teardown(() => agent.close());
  await t.rejects(
    fetch("/proxy/https://httpbin.org/delay/35", {
      dispatcher: agent,
      signal: AbortSignal.timeout(1000),
      headers: { Connection: "close" },
    }),
    { name: "AbortError" },
  );
});
