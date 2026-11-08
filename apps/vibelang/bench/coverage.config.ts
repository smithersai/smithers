// Stays .ts: Vitest loads configuration through Vite's JS/TS-only config loader.
import { defineConfig, mergeConfig } from "vitest/config"
import config from "./config.ts"
export default mergeConfig(config, defineConfig({ test: {
  benchmark: { enabled: false },
  coverage: {
    provider: "v8", autoAttachSubprocess: true, excludeAfterRemap: true, include: ["src/**/*.vibe", "worker/**/*.vibe", "infra/**/*.vibe", "scripts/**/*.vibe", "dist-factory/**/*.js", "dist-scripts/**/*.js", "dist-script-tests/**/*.js"],
    // The browser bundle is excluded here on purpose: its zero-hit placeholder would union a second, minified
    // statement structure into every source it contains. Real Chromium execution joins by location in
    // bench/merge-coverage.ts from coverage/bench/chromium-raw instead (0017).
    reporter: ["text", "json", "json-summary", "html", "lcov"], reportsDirectory: "coverage/bench",
    // The 100% per-file gate is the merged check in bench/merge-coverage.ts (0017): workerd execution evidence
    // exists only after this process exits, so this collection stage enforces nothing.
    reportOnFailure: true,
  },
} }))
