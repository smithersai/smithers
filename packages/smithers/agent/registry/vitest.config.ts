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
      // Everything reachable is covered. The remainder is three defensive
      // guards in `ModuleMetadata` that no input can reach: the `?? ""`
      // fallbacks in `skipTrivia` and `nextToken` (both sit behind an
      // `index < source.length` check, so the indexed read is always a
      // string), and the unmatched-brace return in `objectProperties` (every
      // property value is sliced out of an already brace-balanced
      // declaration).
      //
      // The floors are the measured coverage, so a regression fails here
      // rather than draining silently. Raise them when a guard is proven
      // reachable and covered; never lower them to make a run pass.
      thresholds: {
        branches: 99.77,
        functions: 100,
        lines: 99.91,
        statements: 99.91
      }
    }
  }
})
