import { bindings, defineConfig, exports, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "aipipe",
    entrypoint: "src/worker.js",
    compatibilityDate: "2025-04-15",
    domains: ["aipipe.org"],
    triggers: [triggers.scheduled({ schedule: "0 */6 * * *" })],
    env: {
      AIPIPE_COST: bindings.durableObject({ worker: "aipipe", exportName: "AIPipeCost" }),
      PUBLIC_STATS: bindings.r2({ name: "aipipe-public-stats" }),
    },
    // Preserve the existing SQLite class and namespace when adopting cf's lifecycle management.
    exports: {
      AIPipeCost: exports.durableObject({ storage: "sqlite" }),
    },
    observability: {
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
    },
  },
});
