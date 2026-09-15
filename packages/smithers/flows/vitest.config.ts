import { tmpdir } from "node:os"
import { join } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    environment: "node",
    // These files launch process trees, guest runtimes, and containers. Keep
    // their host resources serial under coverage as well as ordinary tests;
    // core-count worker fanout made startup exceed otherwise sufficient bounds.
    fileParallelism: false,
    // Retain a finite wall-clock guard for hangs. Individual integration
    // journeys declare their own process/container bounds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds: a red gate fails the run (issues #20/#32).
      enabled: true,
      provider: "v8",
      // Scope the report directory and the `.tmp` scratch dir the v8
      // provider clears at run start and reads at run end to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other: one aborts with a removed-coverage-
      // directory error and the other enforces 100% against a partial
      // profile with every test passing (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-flows-coverage-${process.pid}`),
      include: ["src/**"],
      // Nested packages have their own coverage gates. Absolute patterns keep
      // checkout ancestors such as `review-harness` out of exclusion matching.
      exclude: [
        "artifacts/**",
        "canonical/**",
        "capability/**",
        "core/**",
        "crypto/**",
        "database/**",
        "engine/**",
        "engine-store/**",
        "flow/**",
        "jj/**",
        "journal/**",
        "kernel/**",
        "keys/**",
        "observability/**",
        "patterns/**",
        "plan/**",
        "platform-browser/**",
        "platform-bun/**",
        "platform-node/**",
        "run-store/**",
        "sandbox/**",
        "step-cache/**",
        "sync/**",
        "time-travel/**"
      ],
      // Accurate, enforceable floors measured against the committed suite.
      // Ratchet upward as tests land; never lower without a written
      // justification.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
