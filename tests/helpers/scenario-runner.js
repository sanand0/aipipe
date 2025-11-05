// @ts-check
import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { salt } from "../../src/config.example.js";
import { createToken } from "../../src/utils.js";
import {
  applyPlaceholders,
  buildRequestInit,
  loadRequestFixture,
  loadResponseFixture,
  registerMockFromFixture,
} from "../fixtures/index.js";

const DEFAULT_EMAIL = "test@example.com";

export async function resolveScenarioReplacements(scenario) {
  const replacements = structuredClone(scenario.replacements ?? {});

  if (scenario.token) {
    const { email = DEFAULT_EMAIL, useSalt = false, salt: explicitSalt } = scenario.token;
    const tokenOptions = {};
    const saltValue = explicitSalt ?? (useSalt ? salt[email] : undefined);
    if (saltValue) tokenOptions.salt = saltValue;
    replacements.token = await createToken(email, env.AIPIPE_SECRET, tokenOptions);
  }

  return replacements;
}

export async function runScenario({ scenario, fetchMock, before, after }) {
  const replacements = await resolveScenarioReplacements(scenario);
  const context = {};

  if (before) await before({ scenario, replacements, context });

  const requestFixture = await loadRequestFixture(scenario.request);
  await registerMockFromFixture(fetchMock, requestFixture, replacements);

  const path = applyPlaceholders(requestFixture.path, replacements);
  const init = buildRequestInit(requestFixture, replacements);
  const response = await SELF.fetch(`https://example.com${path}`, init);

  const result = { scenario, replacements, requestFixture, response, context };

  if (after) await after(result);

  return result;
}

export async function assertScenarioExpectations(expectation = {}, response) {
  if (!expectation) return;

  if (expectation.status !== undefined) {
    expect(response.status).toBe(expectation.status);
  }

  if (expectation.headers) {
    for (const [key, value] of Object.entries(expectation.headers)) {
      expect(response.headers.get(key)).toBe(value);
    }
  }

  if (expectation.body) {
    const body = await response.clone().json();
    if (expectation.body.responseFixture) {
      const expected = await loadResponseFixture(expectation.body.responseFixture);
      expect(body).toEqual(expected.body ?? expected);
    }
    if (expectation.body.messageIncludes) {
      expect(String(body.message).toLowerCase()).toContain(expectation.body.messageIncludes.toLowerCase());
    }
    if (expectation.body.messagePattern) {
      expect(String(body.message)).toMatch(new RegExp(expectation.body.messagePattern));
    }
  }
}
