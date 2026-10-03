import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import config from "./cloudflare.config.ts";

const { worker } = config;

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: true,
        main: new URL(worker.entrypoint, import.meta.url).pathname,
        miniflare: {
          compatibilityDate: worker.compatibilityDate,
          durableObjects: Object.fromEntries(
            Object.entries(worker.env).map(([name, binding]) => [name, {
              className: binding.exportName,
              useSQLite: worker.exports[binding.exportName].storage === "sqlite",
            }]),
          ),
          bindings: {
            AIPIPE_SECRET: "test-secret",
            OPENROUTER_API_KEY: "test-openrouter-key",
            OPENAI_API_KEY: "test-openai-key",
            GEMINI_API_KEY: "test-gemini-key",
            ADMIN_EMAILS: "admin@example.com",
          },
        },
      },
    },
  },
});
