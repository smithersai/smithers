// Playwright loads configurations only through its JavaScript/TypeScript loader.
import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { Duration } from "effect"
const port = Number(process.env.E2E_4501 ?? 4501)
// The web server's start includes the site build: minutes on a 4-vCPU box or a loaded host. E2E_SERVER_SECONDS sets it.
// The fuzz flow's build stage has run wiki:build; `--mode fuzz` builds only index.html, the site the targets visit
// (vite.config.ts), without the e2e build's four e2e-only pages (0015, "A cheap landing check").
// Preview listens on 127.0.0.1, the address polled: a box resolves localhost to ::1 first, so it never answered there.
const serverMs = Number(process.env.E2E_SERVER_SECONDS ?? 600) * 1000
const budget = Duration.toMillis(Duration.fromInputUnsafe((process.env.FUZZ_BUDGET ?? "25 seconds") as Duration.Input))
// A script a page loads again (a goto per execution) is taken from V8's compilation cache, compiled without block
// counters: Chromium then reports it call-count only, and merging drops its branch evidence (fuzz/browser-coverage.ts
// refuses such a test). Without the cache every load compiles with counters.
export default defineConfig({
  testDir: ".", testMatch: "browser.spec.ts", workers: Number(process.env.FUZZ_BROWSER_WORKERS ?? 1), fullyParallel: true, timeout: budget + 120_000,
  reporter: [["list"], ["./browser-reporter.ts"]],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure", video: "retain-on-failure" },
  projects: [{ name: "fuzz-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1000, height: 800 }, launchOptions: { args: ["--js-flags=--no-compilation-cache"] } } }],
  webServer: { cwd: fileURLToPath(new URL("../", import.meta.url)), command: `pnpm exec vite build --mode fuzz --sourcemap && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: serverMs },
})
