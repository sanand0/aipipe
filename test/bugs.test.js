import t from 'tap';
import { JSDOM } from 'jsdom';
import { getProfile } from '../public/aipipe.js';
import { providers } from '../src/providers.js';

// Utility to run code within JSDOM context
function runInDom(url, fn) {
  const dom = new JSDOM('<!DOCTYPE html>', { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  const result = fn(dom.window);
  delete global.window;
  delete global.document;
  delete global.localStorage;
  return { result, dom };
}

// Bug: getProfile drops other query parameters because URLSearchParams.length is undefined
// Expectation: after calling getProfile on a URL with ?foo=1&aipipe_token=x
// the remaining search string should be '?foo=1'

t.test('getProfile should preserve non-aipipe query parameters', (t) => {
  const { dom } = runInDom('https://example.com/?foo=1&aipipe_token=x', () => {
    return getProfile();
  });
  t.equal(dom.window.location.search, '?foo=1');
  t.end();
});

// Bug: similarity.transform duplicates documents when topics are omitted
// The embeddings API should receive input equal to docs length, not doubled

t.test('similarity.transform avoids duplicate docs when topics missing', async (t) => {
  let received;
  global.fetch = async (url, options) => {
    received = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ data: [ { embedding: [1] }, { embedding: [1] } ], usage: { prompt_tokens: 2 } })
    };
  };
  const req = new Request('https://example.com/similarity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docs: ['a', 'b'] })
  });
  await providers.similarity.transform({ request: req, env: { OPENAI_API_KEY: 'k' } });
  t.equal(received.input.length, 2);
  delete global.fetch;
});
