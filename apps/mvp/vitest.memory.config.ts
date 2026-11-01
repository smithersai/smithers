import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"
export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../packages/repo-targets/test-utils/test-schemas.ts", import.meta.url)),
      fileURLToPath(new URL("../../packages/repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../packages/repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: ["src/features/agent/memory.test.ts", "evals/memory.eval.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/features/agent/memory.ts", "src/features/agent/memoryFlows.ts"],
      reportsDirectory: join(tmpdir(), `mvp-memory-coverage-${process.pid}`),
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 }
    }
  }
})
