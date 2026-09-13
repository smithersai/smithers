import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL("./test/RequireWasm.ts", import.meta.url))],
    // The fault tier lives under `test/faults` and runs from
    // `vitest.faults.config.ts` instead, serially and without coverage: its
    // cases kill process groups and bind ports, which no unit suite sharing
    // this machine can survive beside them.
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/faults/**"],
    environment: "node",
    // This package is the last one still on Vitest's 5 s/10 s defaults, and
    // it is the one that can least afford them: `NodeJj` spawns the real `jj`
    // binary and every suite in the package competes for the same working-copy
    // lock, while the WASM suites load and drive `flows_jj.wasm`. Under the
    // recursive root gate those run alongside every other package's workers,
    // where correct cases have been measured well past the default wall — the
    // machine-load multiplier, not the workload, is what fails them. The
    // budget stays FINITE so a genuine hang still fails the run.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-jj-coverage-${process.pid}`),
      include: ["src/**/*.ts"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
