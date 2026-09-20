import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-registry-coverage-${process.pid}`),
      include: ["src/**"],
      // Every function is covered, and the two misses are guards no input can
      // reach. The statement is `ModuleMetadata`'s unmatched-brace return in
      // `objectProperties`, whose every property value is sliced out of an
      // already brace-balanced declaration. The branch is the tie arm of
      // `ModuleClosure`'s closure sort: it orders the values of a Map KEYED BY
      // the very `path` it compares, so two entries can never carry the same
      // one and the comparator never answers 0.
      //
      // The floors are the measured coverage, so a regression fails here
      // rather than draining silently. Raise them when a guard is proven
      // reachable and covered; never lower them to make a run pass.
      thresholds: {
        branches: 99.9,
        functions: 100,
        lines: 99.93,
        statements: 99.93
      }
    }
  }
})
