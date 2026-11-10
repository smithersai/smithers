import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"
import { nativeSetupFile } from "./test/native/config.ts"

// Each Node runner owns a private report directory. Keep it until reporting has
// finished, including failed runs, then remove it when the runner exits.
// Reports stay outside the checkout so concurrent declaration discovery never
// walks a temporary coverage tree while the reporter removes it.
const reportsDirectory = process.versions.bun ? undefined : (() => {
  const directory = mkdtempSync(join(tmpdir(), "flows-platform-bun-coverage-"))
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }))
  return directory
})()

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json", register: true })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-schemas.ts", import.meta.url)),
      ...process.versions.bun ? [] : [nativeSetupFile]
    ],
    include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
    environment: "node",
    // The V8 native transport is collected by Node; Bun compatibility workers do not own another native fixture.
    exclude: [...configDefaults.exclude, ...(process.versions.bun ? ["test/native.test.vibe"] : [])],
    setupFiles: ["./test/BunRuntime.setup.ts"],
    // Like platform-node, these contracts exercise real filesystem operations,
    // child processes, jj, and loopback HTTP. The macOS runner exceeded
    // Vitest's 5 s default in the filesystem contract; retain the same finite
    // 30 s test and cleanup budgets used by the Node host suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: !process.versions.bun,
      // This directory is fresh; cleaning would recreate it with broader permissions.
      clean: false,
      provider: "v8",
      ...(reportsDirectory === undefined ? {} : { reportsDirectory }),
      include: ["src/**/*.{ts,vibe}"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
