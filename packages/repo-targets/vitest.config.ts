import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Tests start Node on source that reaches VibeLang packages; register: true loads .vibe in those processes.
  plugins: [vibelang({ project: "tsconfig.json", register: true })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("test-utils/test-schemas.ts", import.meta.url)),
      fileURLToPath(new URL("test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: ["test/**/*.test.{ts,vibe}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-repo-targets-coverage-${process.pid}`),
      include: ["src/**"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
