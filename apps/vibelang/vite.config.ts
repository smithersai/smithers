// Stays .ts: Vite and Vitest load their config through Vite's config loader, which bundles JS/TS files only.
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

// The browser picks the mock Factory (no backend, no model) unless its origin's API says it is live
// (wiki/decisions/0004-mock-mode.md, 0010-live-agent.md). `--mode e2e` adds the fault-injection page the recovery tests
// drive. `vitest --mode workerd` runs only the suites that start local workerd (`pnpm test:workerd`), in Node.
const WORKERD = "test/**/*.workerd.test.{ts,vibe}"

export default defineConfig(({ mode }) => ({
  plugins: [vibelang()],
  build: {
    target: "es2022", sourcemap: true,
    ...(mode === "e2e" ? { rolldownOptions: { input: ["index.html", "e2e/runtime/index.html"] } } : {}),
  },
  server: { port: 5178 },
  test: {
    environment: mode === "workerd" ? "node" : "happy-dom",
    include: mode === "workerd" ? [WORKERD] : ["test/**/*.test.{ts,vibe,mjs}"],
    exclude: mode === "workerd" ? configDefaults.exclude : [...configDefaults.exclude, WORKERD],
    ...(mode === "workerd" ? { testTimeout: 120_000, hookTimeout: 120_000 } : {}),
    // Foldkit ships ESM that Vitest must transform with the app.
    server: { deps: { inline: ["foldkit"] } },
  },
}))
