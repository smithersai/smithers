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
    setupFiles: ["test/fixtures/BrowserLocks.ts"],
    // The real-browser suites run under vitest.browser.config.ts.
    exclude: ["**/node_modules/**", "test/browser/**"],
    // The BrowserHost contract runs jj over the real flows_jj.wasm; the first
    // operation pays WebAssembly compilation, which can exceed the 5s default.
    testTimeout: 60_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-platform-browser-coverage-${process.pid}`),
      include: ["src/**/*.{ts,vibe}"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
