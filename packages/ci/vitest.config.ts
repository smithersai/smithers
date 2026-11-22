import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config"

/**
 * The sources each part of //packages/ci:test holds to 100% coverage: what its own cases cover in full. A file the
 * cases of one directory do not reach in full is held by the part whose cases do (measured 2026-11-21, one coverage
 * run per part over all of src). Every other source, and any new one outside these, is held by `testRest`.
 */
export const held = {
  cli: ["src/cli/**", "src/apply/Check.vibe", "src/apply/Former.ts"],
  replay: ["src/replay/**", "src/contract/Command.ts"],
  native: ["src/native/**"]
} as const

/**
 * The workers of each part, by its share of the suite's measured time (cli 30%, replay 29%, native 23%, the rest
 * 18%): twelve in all, so the four parts at once run what the whole suite did.
 */
export const partWorkers = { cli: 4, replay: 3, native: 3, rest: 2 } as const

/** What a part holds less what an earlier part of `held` holds already. */
export const heldBy = (part: keyof typeof held): { coverage: Array<string>; coverageExclude: Array<string> } => {
  const parts = Object.keys(held) as Array<keyof typeof held>
  const earlier = parts.slice(0, parts.indexOf(part)).flatMap((other) =>
    held[other].filter((path) => !path.endsWith("/**"))
  )
  return { coverage: [...held[part]], coverageExclude: earlier }
}

/**
 * The suite, or one part of it: the cases under `include` (less `exclude`), with 100% coverage held over `coverage`.
 * The whole suite runs here; `//packages/ci:test` runs it as four parts (vitest.part-*.config.ts), each in its own CI
 * job, because together they run past a job's hour on a GitHub runner.
 */
export const suite = (part: {
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly coverage?: ReadonlyArray<string>
  readonly coverageExclude?: ReadonlyArray<string>
  readonly workers?: number
} = {}) =>
  defineConfig({
    plugins: [vibelang({ project: "tsconfig.test.json" })],
    // The VibeLang plugin logs each type warning of a .vibe module it compiles (unstableApiUsage and the like): over
    // 32 KB per run, which is all a failed target keeps of its output, so a failed part's coverage report and its
    // failing cases were cut. `vibelang` in `check` reports the same warnings.
    logLevel: "error",
    test: {
      globalSetup: [
        fileURLToPath(new URL("../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
        fileURLToPath(new URL("../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
      ],
      environment: "node",
      // Each test file starts real builds, and a build starts compilers that use a thread for every core. With a
      // worker per core, a 48-core build server at its 32-core limit ran 90 compilers of 50 to 97 threads at once
      // (load 650) and tests that take seconds took ten minutes. Twelve workers leave the builds room; a machine
      // with fewer cores is unaffected. `//packages/ci:test` runs its four parts at once on one machine, so they
      // share the twelve (`partWorkers`).
      maxWorkers: part.workers ?? 12,
      // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
      // wall-clock budget so correct suites survive coverage-instrumented load
      // while a genuine hang still fails the run.
      // The suite starts real processes (git, smthrs, the program itself). On a build server at load 117 a test that
      // takes 6 s idle passed 30 s; the limit is for a hang, not for speed.
      testTimeout: 120_000,
      hookTimeout: 120_000,
      include: [...(part.include ?? [...configDefaults.include, "test/**/*.test.vibe"])],
      // The wall-time benchmarks run on their own (`//packages/ci:bench`, vitest.benchmark.config.ts): a bound on a time
      // fails with the machine's load, not with the code, and the suite must not.
      exclude: [...configDefaults.exclude, "test/**/*.benchmark.test.ts", ...(part.exclude ?? [])],
      coverage: {
        enabled: true,
        provider: "v8",
        // Per-process report directory so concurrent vitest runs do not destroy
        // each other's coverage scratch state (issues #115/#121).
        reportsDirectory: join(tmpdir(), `flows-ci-coverage-${process.pid}`),
        include: [...(part.coverage ?? ["src/**"])],
        exclude: [...coverageConfigDefaults.exclude, ...(part.coverageExclude ?? [])],
        // The files short of full coverage, each with every line it misses: a failed part keeps only 32 KB of output.
        reporter: [["text", { skipFull: true, maxCols: 400 }]],
        thresholds: {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100
        }
      }
    }
  })

export default suite()
