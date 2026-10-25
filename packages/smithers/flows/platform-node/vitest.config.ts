import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
    environment: "node",
    // Executes the checkout helper at its current source, never a stale build.
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url)),
      "./test/RebuildNativeHelper.ts"
    ],
    // These suites drive a real filesystem — deep trees, pathological removals,
    // child-process lifecycles — under v8 coverage across parallel workers.
    // Vitest's 5 s default put five correct cases over the wall on a developer
    // macOS host (measured 2026-08-16); all 106 pass with room at this budget.
    // Same reasoning, and same finite bound, as packages/smithers/flows/database.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-platform-node-coverage-${process.pid}`),
      include: ["src/**/*.{ts,vibe}"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
