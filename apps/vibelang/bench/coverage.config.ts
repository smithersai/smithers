// Stays .ts: Vitest loads configuration through Vite's JS/TS-only config loader.
import { defineConfig, mergeConfig } from "vitest/config"
import config from "./config.ts"
export default mergeConfig(config, defineConfig({ test: {
  benchmark: { enabled: false },
  coverage: {
    provider: "v8", autoAttachSubprocess: true, excludeAfterRemap: true, include: ["src/**/*.vibe", "worker/**/*.vibe", "infra/**/*.vibe", "scripts/**/*.vibe", "dist-factory/**/*.js", "dist/assets/*.js"],
    // Generated bundler bootstrap has no production source; reason recorded in decision 0017.
    exclude: ["dist/assets/rolldown-runtime-*.js"],
    reporter: ["text", "json", "json-summary", "html", "lcov"], reportsDirectory: "coverage/bench",
    reportOnFailure: true, thresholds: { perFile: true, lines: 100, branches: 100, functions: 100, statements: 100 },
  },
} }))
