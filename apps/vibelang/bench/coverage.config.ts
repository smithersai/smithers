// Stays .ts: Vitest loads configuration through Vite's JS/TS-only config loader.
import { defineConfig, mergeConfig } from "vitest/config"
import config from "./config.ts"
import appConfig from "../vite.config.ts"
// Reuse lane 0016's canonical provider, subprocess collection and complete source roster. Only the benchmark
// include list runs; its 100% thresholds are enforced after workerd/Chromium evidence joins below (0017).
const { thresholds: _collectionThresholds, ...sharedCoverage } = appConfig({ mode: "test", command: "serve" }).test?.coverage ?? {}
export default mergeConfig(config, defineConfig({ test: {
  benchmark: { enabled: false },
  coverage: {
    ...sharedCoverage,
    provider: "v8", excludeAfterRemap: true,
    // The browser bundle is excluded here on purpose: its zero-hit placeholder would union a second
    // statement structure into every source it contains. Real Chromium execution joins by location in
    // bench/merge-coverage.ts from coverage/bench/chromium-raw instead (0017).
    reportsDirectory: "coverage/bench",
    // The 100% per-file gate is the merged check in bench/merge-coverage.ts (0017): workerd execution evidence
    // exists only after this process exits, so this collection stage enforces nothing.
    reportOnFailure: true,
  },
} }))
