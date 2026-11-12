import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"
import { nativeUnavailableReason } from "./test/native/prerequisites.ts"

// Each Node runner owns a private report directory. Keep it until reporting has
// finished, including failed runs, then remove it when the runner exits.
// Reports stay outside the checkout so concurrent declaration discovery never
// walks a temporary coverage tree while the reporter removes it.
const reportsDirectory = process.versions.bun ? undefined : (() => {
  const directory = mkdtempSync(join(tmpdir(), "flows-platform-bun-coverage-"))
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }))
  return directory
})()

const schemaSetup = fileURLToPath(new URL("../../../repo-targets/test-utils/test-schemas.ts", import.meta.url))
const nativeSetup = fileURLToPath(new URL("./test/native/config.ts", import.meta.url))
const nativeReason = nativeUnavailableReason({
  platform: process.platform,
  bun: process.versions.bun !== undefined,
  path: process.env.PATH ?? "",
  browser: () => createRequire(import.meta.url)("playwright").chromium.executablePath()
})
if (nativeReason !== undefined && !process.versions.bun) console.warn(`Native desktop tests omitted: ${nativeReason}`)

export const projects = (nativeAvailable: boolean) => [
  {
    extends: true as const,
    test: {
      name: "portable",
      include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
      globalSetup: [schemaSetup],
      exclude: [...configDefaults.exclude, "test/native.test.vibe"]
    }
  },
  ...(nativeAvailable
    ? [{
      extends: true as const,
      test: {
        name: "native",
        include: ["test/native.test.vibe"],
        globalSetup: [schemaSetup, nativeSetup]
      }
    }]
    : [])
]

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json", register: true })],
  test: {
    projects: projects(nativeReason === undefined),
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
      include: ["src/**/*.{ts,vibe}"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
