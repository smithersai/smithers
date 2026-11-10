// Stays .ts: Playwright loads configuration by JS/TS extension only.
// Fault-path coverage workloads (bench/browser-faults.spec.ts) on the `e2e` build, built into dist-e2e/ so the
// timing and source-coverage build in dist/ stays the one bench/browser.spec.ts measured (decision 0017).
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"
const port = Number(process.env.BENCH_FAULTS_PORT ?? Number(process.env.E2E_PORT ?? 4503) + 1)
export default defineConfig({
  testDir: ".", testMatch: "browser-faults.spec.ts", workers: 1, timeout: 45_000, globalTimeout: 300_000,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 }, colorScheme: "dark", actionTimeout: 10_000, navigationTimeout: 30_000 },
  webServer: { cwd: fileURLToPath(new URL("..", import.meta.url)), command: `pnpm wiki:build && pnpm exec vite build --mode e2e --outDir dist-e2e && pnpm exec vite preview --outDir dist-e2e --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000 },
})
