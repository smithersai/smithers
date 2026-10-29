import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("./test/fixtures/presentation-coverage.ts", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
    environment: "node",
    // A finite budget that survives coverage-instrumented load, so a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      autoAttachSubprocess: true,
      // One report directory per process, so concurrent runs never destroy each other's coverage scratch.
      reportsDirectory: join(tmpdir(), `flows-views-coverage-${process.pid}`),
      // Include emitted realm scripts so V8 remaps their execution to src/.
      include: ["src/**/*.{ts,vibe}", "test-bundles/**/*.js"],
      excludeAfterRemap: true,
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
