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
      reportsDirectory: join(tmpdir(), `flows-std-coverage-${process.pid}`),
      include: ["src/**"],
      // A floor below what the suite already measures is not a ratchet: it
      // lets a regression that deletes a covered branch land green. These sit
      // just under the measured run (93.38 / 84.45 / 88.73 / 95.13) and are
      // raised with every suite added, toward the repository's 100% baseline.
      // What still keeps them off 100 is named per file: Lsp and WebFetch
      // error branches, ShellCommand's Codex-parity output shaping, and the
      // NodeLanguageServer paths that need a real language server to reach.
      thresholds: {
        branches: 84,
        functions: 88,
        lines: 94,
        statements: 93
      }
    }
  }
})
