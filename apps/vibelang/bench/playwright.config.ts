// Stays .ts: Playwright loads configuration by JS/TS extension only.
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"
const live = process.env.BENCH_LIVE === "1"
const sourceCoverage = process.env.BENCH_COVERAGE === "1"
const build = sourceCoverage ? "pnpm wiki:build && pnpm exec vite build --mode bench-coverage" : "pnpm build"
const port = Number(process.env.E2E_4503 ?? process.env.E2E_PORT ?? 4503)
// The web server's start includes the site build: minutes on a 4-vCPU box or a loaded host. E2E_SERVER_SECONDS sets it.
// Preview listens on 127.0.0.1, the address polled: a box resolves localhost to ::1 first, so it never answered there.
const serverMs = Number(process.env.E2E_SERVER_SECONDS ?? 600) * 1000
// Each test keeps its own deadline. The local global deadline also spans the web server build (a source-coverage
// build under BENCH_COVERAGE) and all seven workloads: 90 s stopped the coverage run after four passed tests.
export default defineConfig({
  testDir: ".", testMatch: "browser.spec.ts", workers: 1, timeout: live ? 180_000 : 45_000, globalTimeout: live ? 600_000 : serverMs + 300_000,
  use: { baseURL: live ? "https://vibelang.smithers.sh" : `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 }, colorScheme: "dark", actionTimeout: 10_000, navigationTimeout: 30_000 },
  ...(live ? {} : { webServer: { cwd: fileURLToPath(new URL("..", import.meta.url)), command: `${build} && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: serverMs } }),
})
