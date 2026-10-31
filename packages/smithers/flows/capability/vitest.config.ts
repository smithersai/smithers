import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

// A test that runs `node` or `bun` on the sources reaches `.vibe` modules,
// which load through VibeLang's register hook and Bun plugin.
const resolve = createRequire(import.meta.url).resolve
const withOption = (inherited: string | undefined, option: string): string =>
  [inherited, option].filter((value) => value !== undefined && value !== "").join(" ")
const nodeOptions = withOption(process.env.NODE_OPTIONS, `--import=${pathToFileURL(resolve("vibelang/register")).href}`)
const bunOptions = withOption(process.env.BUN_OPTIONS, `--preload=${resolve("vibelang/bun")}`)

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
    environment: "node",
    env: { NODE_OPTIONS: nodeOptions, BUN_OPTIONS: bunOptions },
    // Vitest's 5 s default is a wall-clock budget measured under coverage
    // instrumentation across parallel workers, where correct suites have been
    // measured 6-12x slower than in isolation. Raise the budget instead of
    // trimming the workload, and keep it FINITE so a genuine hang still fails
    // the run (issues #115/#121).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-capability-coverage-${process.pid}`),
      include: ["src/**/*.{ts,vibe}"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
