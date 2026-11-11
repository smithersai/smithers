import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: ["test/**/*.test.{ts,vibe}"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `rpc-coverage-${process.pid}`),
      include: ["src/**/*.{ts,vibe}"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
