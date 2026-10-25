import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    environment: "node",
    include: ["test/**/*.test.{ts,vibe}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed. The floors are the
      // measured coverage on 2026-09-01, rounded down to whole percentages.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-targets-coverage-${process.pid}`),
      include: ["src/**"],
      thresholds: {
        branches: 97,
        functions: 99,
        lines: 99,
        statements: 99
      }
    }
  }
})
