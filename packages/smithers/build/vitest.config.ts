import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    environment: "node",
    // Only this package's own suite. `infra/` is its own workspace package
    // with its own vitest run; `docs/`, `terraform/`, and `scripts/` carry no
    // vitest tests.
    include: ["test/**/*.test.{ts,vibe}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // Every run measures all shipped source and requires complete coverage.
      // Keep these thresholds aligned with the repository's testing rule.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-coverage-${process.pid}`),
      include: ["src/**"],
      // Nested packages have their own coverage gates. Absolute patterns keep
      // checkout ancestors such as `review-harness` out of exclusion matching.
      exclude: ["build-cli/**", "infra/**", "targets/**"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
