import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  // Tests start Node on source that reaches VibeLang packages; register: true loads .vibe in those processes.
  plugins: [vibelang({ project: "tsconfig.test.json", register: true })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
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
      reportsDirectory: join(tmpdir(), `flows-integrations-coverage-${process.pid}`),
      include: ["src/**"],
      // Ratcheted to exactly what one storage backend reaches. Raise these
      // when a case closes; never lower them.
      //
      // The numbers carry no slack, so any new uncovered branch fails the
      // gate. Only the three `test/*Live.test.ts` suites change the figures,
      // and only upward: they execute more of `src` when a credential is
      // present, and `include` fixes the denominator whether they run or not.
      //
      // The one shortfall is `core/SourceStore.ts:930`, the PostgreSQL arm of
      // the text search. The database matrix (`pnpm coverage`, the package's
      // `test` target) runs every suite on real SQLite and real PostgreSQL and
      // merges the two to 100% on all four measures.
      thresholds: {
        branches: 100,
        functions: 99.78,
        lines: 99.93,
        statements: 99.94
      }
    }
  }
})
