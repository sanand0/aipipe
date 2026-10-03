import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "aipipe",
    entrypoint: "src/worker.js",
    compatibilityDate: "2025-04-15",
    domains: ["aipipe.org"],
    env: {
      AIPIPE_COST: bindings.durableObject({ worker: "aipipe", exportName: "AIPipeCost" }),
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
