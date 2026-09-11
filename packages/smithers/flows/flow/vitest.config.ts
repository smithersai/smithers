import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"
import { parseCLI } from "vitest/node"
import { coversWholeSuite } from "./test/CoverageGate.ts"

export default defineConfig({
  test: {
    environment: "node",
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
    // Reclaims the scratch report below once the thresholds have been checked.
    globalSetup: ["./test/CoverageTeardown.ts"],
    coverage: {
      // A whole-suite run — `vitest run`, which is what the `test` target
      // invokes — computes and ENFORCES these thresholds, so a red gate fails
      // the run (issue #20). A run narrowed to some files or names cannot
      // reach 100% however green it is, so it skips coverage; see
      // `test/CoverageGate.ts`. An explicit `--coverage` still wins.
      enabled: coversWholeSuite(parseCLI(["vitest", ...process.argv.slice(2)], { allowUnknownOptions: true })),
      provider: "v8",
      // Scope the report directory — and the `.tmp` scratch dir the v8
      // provider clears at run start and reads at run end — to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other: one aborts with a removed-coverage-
      // directory error and the other enforces 100% against a partial
      // profile with every test passing (issues #115/#121). The globalSetup
      // above removes it after the run; `pnpm coverage` writes `coverage/`
      // instead so the report outlives the run.
      reportsDirectory: join(tmpdir(), `flows-flow-coverage-${process.pid}`),
      // Every production module, including the public barrel, is measured.
      include: ["src/**"].map((pattern) => join(import.meta.dirname, pattern)),
      // The sibling package has its own gate; resolve it from this config so
      // a checkout ancestor cannot match the exclusion.
      exclude: ["../canonical/**"].map((pattern) => join(import.meta.dirname, pattern)),
      // The suite must earn complete coverage in every category.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
