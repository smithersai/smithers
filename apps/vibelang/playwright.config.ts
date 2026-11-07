import { defineConfig, devices } from "@playwright/test"

// End-to-end tests drive the real built app in a browser. Mock mode needs no backend, so the preview server is the
// whole stack. `E2E_BASE_URL` sends product cases to a deployment; transport-fault cases always use the local host.
const deployed = process.env.E2E_BASE_URL
// Parallel checkouts on one machine each pick their own port.
const port = Number(process.env.E2E_PORT ?? 4173)

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // Keep the original three-browser concurrency as the suite gains files; this machine also runs other lanes.
  workers: 3,
  use: {
    baseURL: deployed ?? `http://127.0.0.1:${port}`,
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "dark", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "dark" } },
    { name: "light", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "light" } },
    { name: "phone", use: { ...devices["Pixel 7"], colorScheme: "dark" } },
  ],
  // The local e2e build also serves the fault-injection pages the recovery tests use, even when the rest run against a
  // deployment.
  webServer: { command: `pnpm build --mode e2e && pnpm exec vite preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000 },
})
