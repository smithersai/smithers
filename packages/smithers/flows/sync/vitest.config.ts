import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // The retained-heap assertion in ServerSoak compares heapUsed across a
    // forced collection; without --expose-gc the measurement floats with
    // machine load (observed ~78 MB vs the 64 MB budget on a busy host).
    // `execArgv` is top level in Vitest 4; the 3.x `poolOptions.forks.execArgv`
    // shape is accepted by the config type and silently ignored, which is how
    // an --expose-gc that never reached the worker looks.
    pool: "forks",
    execArgv: ["--expose-gc"],
    // Vitest's 5 s default is a wall-clock budget, but no suite in this repo
    // asserts on elapsed time — each is bounded by an explicit iteration,
    // cycle, or completion count. The real gate runs those counts under v8
    // coverage instrumentation across parallel workers, where cases that
    // finish in well under a second in isolation have been measured 6-12x
    // slower; that machine-load multiplier, not the workload, is what put
    // correct suites over the default wall. Raise the budget instead of
    // trimming the workload, and keep it FINITE so a genuine hang still
    // fails the run rather than hanging the gate forever.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issue #20).
      enabled: true,
      provider: "v8",
      // Scope the report directory — and the `.tmp` scratch dir the v8
      // provider clears at run start and reads at run end — to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other: one aborts with a removed-coverage-
      // directory error and the other enforces 100% against a partial
      // profile with every test passing (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-sync-coverage-${process.pid}`),
      include: ["src/**"],
      // The suite covers every reachable statement, branch, function, and
      // line in the package, including its test transport boundary.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
