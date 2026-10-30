import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"
import CliSequencer from "./test/support/cli-sequencer.ts"

export default defineConfig({
  // Tests start Node on source that reaches VibeLang packages; register: true loads .vibe in those processes.
  plugins: [vibelang({ project: "tsconfig.test.json", register: true })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../repo-targets/test-utils/test-schemas.ts", import.meta.url)),
      fileURLToPath(new URL("../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    // The fault tier lives under `test/faults` and runs from
    // `vitest.faults.config.ts` instead, serially and without coverage: its
    // cases kill process groups and bind ports, which no unit suite sharing
    // this machine can survive beside them.
    include: ["test/**/*.test.{ts,vibe}"],
    exclude: [...configDefaults.exclude, "test/faults/**"],
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // Files launch real CLI hosts, SQLite engines, and child process trees.
    // Bound that fanout so the default coverage gate does not multiply host
    // startup contention by the machine's core count.
    fileParallelism: false,
    sequence: { sequencer: CliSequencer },
    // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Process-boundary files start the CLI from source hundreds of times, and
    // each start type-strips and compiles the whole module graph. Node's
    // compile cache, keyed by source content, lets every start after the
    // first reuse that work. Global setup supplies a run-owned cache directory.
    //
    // Incur appends "Skills are out of date" to every result when the skills
    // this machine installed (recorded under $XDG_DATA_HOME/incur) predate the
    // command surface. An empty data home keeps the suite's expected output
    // independent of what the developer last ran `smthrs skills add` against.
    env: {
      XDG_DATA_HOME: join(import.meta.dirname, ".cache", "test-data")
    },
    coverage: {
      // Related-file fast gates exercise only the changed behavior; applying
      // whole-package coverage thresholds to that subset always fails.
      // The full suite retains its measured coverage gate and thresholds.
      enabled: !process.argv.includes("related"),
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-smithers-coverage-${process.pid}`),
      include: ["src/**"],
      // Nested packages have their own coverage gates. Absolute patterns keep
      // checkout ancestors such as `review-harness` out of exclusion matching.
      exclude: [
        "agent/**",
        "build/**",
        "control/**",
        "flows/**",
        "gateway/**",
        "mcp/**",
        "migrate/**",
        "notifications/**",
        "ui/**"
      ],
      // Measured (96.42 / 91.61 / 96.46 / 96.84 over 933 cases), then floored
      // to integers, which leaves under a point for the branches that depend on
      // the host: `jj` on PATH and provider keys exported. Deleted coverage
      // still fails the run.
      //
      // the release policy asks every package for 100, and this package is
      // the one that cannot reach it from inside the process being measured.
      // What a command line promises is what a PROCESS does: its exit status,
      // its stderr, the `.flows/` it leaves behind, the second `smithers` it
      // refuses. So `Bin.test.ts`, `BinTeardown.test.ts`,
      // `TwoProcessClaim.test.ts`, `CrossProcessCancel.test.ts`,
      // `EndToEnd.test.ts` and the MCP stdio round trip spawn the real
      // executable and assert against it. v8 attributes that execution to the
      // child, so the residue below is asserted code that this process did not
      // run, not unasserted code. The rest is genuinely out of reach here:
      // `update` reads the npm registry, and `Detached.terminate`'s handle arm
      // is Windows-only, reachable through its `platform` argument and no
      // further. Re-attributing the process cases by re-asserting them in
      // process would buy the number and lose the promise, so the number is
      // what moves.
      thresholds: {
        branches: 91,
        functions: 96,
        lines: 96,
        statements: 96
      }
    }
  }
})
