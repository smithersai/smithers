import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ register: true, project: "tsconfig.test.json" })],
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
      reportOnFailure: true,
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-std-coverage-${process.pid}`),
      include: ["src/**"],
      // Aggregate floors apply across the supported host lanes, which differ
      // in native-process and filesystem tests. Per-file completion gates
      // enforce the coverage campaign without narrowing the source inventory.
      thresholds: {
        // macOS executed 99.78 / 98.88 / 99.59 / 99.78 on 2026-10-03 (#3480).
        // Floors keep a margin for the Linux lane, which skips different
        // platform tests. Per-file gates cover files that reached 100% on
        // macOS; the rest are listed in #3480 with their dead branches.
        branches: 97,
        functions: 99,
        lines: 99,
        statements: 99,
        "src/Write.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/ApplyPatch.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Read.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Edit.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/StdError.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/FileMutation.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/ApplyPatch.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/ExaWebSearch.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Ls.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/NativeSearch.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/HttpNetwork.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/IpAddress.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/SearchConformance.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/SearchContract.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/CodexText.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Html.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Walk.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/TestReport.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Symbols.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Text.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/TreeFingerprint.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Preserve.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Container.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        // T-TRM-05 edits Bash.ts: its terminal handler shares this per-file gate.
        "src/Bash.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Glob.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Grep.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/EnvelopePrecheck.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Grouping.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Http.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Ignore.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Match.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/SearchContract.vibe": { branches: 100, functions: 100, lines: 100, statements: 100 }
      }
    }
  }
})
