import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // The Vitest suites are `test/**` alone. `scripts/flows-backup.test.mjs`
    // is a `node:test` file driven by the `//packages/smithers/flows/engine-store:disasterRecovery`
    // target, and Vitest's default include (`**/*.test.?(c|m)[jt]s`) collects
    // it, where it fails as "No test suite found" because it registers with
    // `node:test` rather than with Vitest. Naming the include keeps each
    // runner to the files it owns.
    include: ["test/**/*.test.ts"],
    // Vitest's 5 s default is a wall-clock budget, but no suite in this repo
    // asserts on elapsed time — each is bounded by an explicit iteration,
    // cycle, or completion count. The real gate runs those counts under v8
    // coverage instrumentation across parallel workers, where cases that
    // finish in well under a second in isolation have been measured 6-12x
    // slower; that machine-load multiplier, not the workload, is what put
    // correct suites over the default wall. Raise the budget instead of
    // trimming the workload, and keep it FINITE so a genuine hang still
    // fails the run rather than hanging the gate forever.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The package has several real-filesystem integration suites. Letting
    // Vitest scale to every logical CPU makes sixteen coverage-instrumented
    // workers contend for the same disk and turns 13-17 s tests into 60 s
    // timeouts. A bounded pool is faster and stable under a loaded CI host.
    maxWorkers: 4,
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issues #20/#32).
      enabled: true,
      provider: "v8",
      // Scope the report directory — and the `.tmp` scratch dir the v8
      // provider clears at run start and reads at run end — to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other: one aborts with a removed-coverage-
      // directory error and the other enforces 100% against a partial
      // profile with every test passing (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-engine-store-coverage-${process.pid}`),
      // Gate on production code only — without this, well-covered helpers
      // under test/ (e.g. test/contract/DurableEngineStateContract.ts)
      // dilute the denominator and give src regressions slack (issue #51).
      include: ["src/**"],
      // The complete src tree, including barrel modules, is fully covered.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
