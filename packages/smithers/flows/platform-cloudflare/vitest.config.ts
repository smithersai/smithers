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
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
    environment: "node",
    // The execution suites build the durable engine over the compose Postgres
    // and drive real flows through it, migrations included, so one case is
    // several seconds of real I/O. The crash case also starts a Node child.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-platform-cloudflare-coverage-${process.pid}`),
      include: ["src/**/*.{ts,vibe}"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
