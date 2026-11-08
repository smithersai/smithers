// Playwright loads configurations only through its JavaScript/TypeScript loader.
import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { Duration } from "effect"
const port = Number(process.env.E2E_4501 ?? 4501)
const budget = Duration.toMillis(Duration.fromInputUnsafe((process.env.FUZZ_BUDGET ?? "25 seconds") as Duration.Input))
export default defineConfig({
  testDir: ".", testMatch: "browser.spec.ts", workers: 1, timeout: budget + 120_000,
  reporter: [["list"], ["./browser-reporter.ts"]],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure", video: "retain-on-failure" },
  projects: [{ name: "fuzz-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1000, height: 800 } } }],
  webServer: { cwd: fileURLToPath(new URL("../", import.meta.url)), command: `pnpm build --mode e2e --sourcemap && pnpm exec vite preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 180_000 },
})
