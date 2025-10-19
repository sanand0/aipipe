import { fetchMock } from "cloudflare:test";
import { afterAll, afterEach, beforeAll } from "vitest";

export function setupMockLifecycle() {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterAll(() => {
    fetchMock.assertNoPendingInterceptors();
    fetchMock.enableNetConnect();
    fetchMock.deactivate();
  });

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  return fetchMock;
}
