import { defineConfig, devices } from "@playwright/test"

// End-to-end tests drive the real built app in a browser. Mock mode needs no backend, so the preview server is the
// whole stack; `E2E_BASE_URL` points the same tests at a deployment instead (wiki/decisions/0008-testing.md).
const deployed = process.env.E2E_BASE_URL

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL: deployed ?? "http://127.0.0.1:4173",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "dark", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "dark" } },
    { name: "light", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "light" } },
    { name: "phone", use: { ...devices["Pixel 7"], colorScheme: "dark" } },
  ],
  ...(deployed ? {} : { webServer: { command: "pnpm build && pnpm preview", url: "http://127.0.0.1:4173", reuseExistingServer: false, timeout: 120_000 } }),
})
