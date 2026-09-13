import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

// Each Node runner owns a private report directory. Keep it until reporting has
// finished, including failed runs, then remove it when the runner exits.
const coverageRoot = join(import.meta.dirname, "coverage")
const reportsDirectory = process.versions.bun ? undefined : (() => {
  mkdirSync(coverageRoot, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(coverageRoot, "run-"))
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }))
  return directory
})()

export default defineConfig({
  test: {
    environment: "node",
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
      include: ["src/**/*.ts"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
