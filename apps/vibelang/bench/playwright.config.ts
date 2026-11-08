// Stays .ts: Playwright loads configuration by JS/TS extension only.
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"
const live = process.env.BENCH_LIVE === "1"
const port = Number(process.env.E2E_4503 ?? process.env.E2E_PORT ?? 4503)
export default defineConfig({
  testDir: ".", testMatch: "browser.spec.ts", workers: 1, timeout: live ? 180_000 : 45_000, globalTimeout: live ? 600_000 : 90_000,
  use: { baseURL: live ? "https://vibelang.smithers.sh" : `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 }, colorScheme: "dark", actionTimeout: 10_000, navigationTimeout: 30_000 },
  ...(live ? {} : { webServer: { cwd: fileURLToPath(new URL("..", import.meta.url)), command: `pnpm build && pnpm exec vite preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000 } }),
})
