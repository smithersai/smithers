// Stays .ts: Vite and Vitest load their config through Vite's config loader, which bundles JS/TS files only.
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"
import { quickjsModule } from "./quickjs.vite.ts"

// The browser picks the mock Factory (no backend, no model) unless its origin's API says it is live
// (wiki/decisions/0004-mock-mode.md, 0010-live-agent.md). `--mode e2e` adds the fault-injection page the recovery tests
// drive. `vitest --mode workerd` runs only the suites that start local workerd (`pnpm test:workerd`), in Node.
const WORKERD = "test/**/*.workerd.test.{ts,vibe}"

export default defineConfig(({ mode }) => ({
  plugins: [vibelang(), quickjsModule],
  // pnpm may bind optional Vitest peers differently; every test must use the CLI's suite context.
  resolve: { dedupe: ["vitest"] },
  build: {
    target: "es2022", sourcemap: true,
    // Source coverage preserves branch statements before minifier folding (0017); timing uses the normal build. The
    // e2e build is measured too (0016, 0015): unminified, its ranges are the compiler's, so Chromium credits them.
    ...(mode === "bench-coverage" || mode === "e2e" ? { minify: false as const } : {}),
    ...(mode === "e2e" ? { rolldownOptions: { input: ["index.html", "e2e/runtime/index.html", "e2e/actions-runtime/index.html", "e2e/coverage-fixtures/index.html"] } } : {}),
  },
  server: { port: 5178 },
  test: {
    environment: mode === "workerd" ? "node" : "happy-dom",
    // Process discovery starts both MCP and CLI; match the workspace's finite budget.
    testTimeout: 30_000,
    // Bound per-lane compiler and real-engine load on the shared host, matching the browser pool.
    maxWorkers: 2,
    include: mode === "workerd" ? [WORKERD] : ["test/**/*.test.{ts,vibe,mjs}"],
    exclude: mode === "workerd" ? configDefaults.exclude : [...configDefaults.exclude, WORKERD],
    ...(mode === "workerd" ? { testTimeout: 120_000, hookTimeout: 120_000 } : {}),
    coverage: {
      provider: "v8",
      autoAttachSubprocess: true,
      include: ["src/**/*.vibe", "worker/**/*.vibe", "scripts/**/*.vibe", "infra/**/*.vibe", "dist-factory/**/*.js", "dist-scripts/**/*.js", "dist-script-tests/**/*.js"],
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      reportsDirectory: mode === "workerd" ? "coverage/workerd" : "coverage/unit",
      reportOnFailure: true,
      thresholds: { perFile: true, lines: 100, branches: 100, functions: 100, statements: 100 },
    },
    // Transform the Effect adapter so Vite can deduplicate its Vitest peer with the running CLI.
    server: { deps: { inline: ["foldkit", "@effect/vitest"] } },
  },
}))
