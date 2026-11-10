// Vitest loads configuration from TypeScript files.
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
export default defineConfig({
  resolve: { alias: { vitest: fileURLToPath(import.meta.resolve("vitest")) } },
  test: {
    globalSetup: [
      fileURLToPath(new URL("../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    server: { deps: { inline: ["@effect/vitest"] } },
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      reportsDirectory: join(tmpdir(), `flows-fuzz-coverage-${process.pid}`),
      reporter: ["text", "json", "json-summary"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 }
    }
  }
})
