import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["cf-tests/**/*.test.js"],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        env: {
          AIPIPE_SECRET: "test-secret",
          OPENROUTER_API_KEY: "test-openrouter-key",
          OPENAI_API_KEY: "test-openai-key",
          GEMINI_API_KEY: "test-gemini-key",
          ADMIN_EMAILS: "admin@example.com",
        },
        wrangler: {
          configPath: "../wrangler.toml",
        },
      },
    },
  },
});
