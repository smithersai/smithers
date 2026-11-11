// Stays .ts: Playwright loads its config by JS/TS extension only.
import { defineConfig, devices } from "@playwright/test"

// End-to-end tests drive the real built app in a browser. Mock mode needs no backend, so the preview server is the
// whole stack. `E2E_BASE_URL` sends product cases to a deployment, still on the mock; transport-fault cases always use
// the local host. `E2E_LIVE_URL` opts in to e2e/live.spec.ts, the live agent.
const deployed = process.env.E2E_BASE_URL
// Parallel checkouts on one machine each pick their own port.
const port = Number(process.env.E2E_4525 ?? process.env.E2E_4527 ?? process.env.E2E_4518 ?? process.env.E2E_4519 ?? process.env.E2E_4522 ?? process.env.E2E_PORT ?? process.env.E2E_4521 ?? process.env.E2E_4510 ?? process.env.E2E_4508 ?? process.env.E2E_4505 ?? process.env.E2E_4501 ?? process.env.E2E_4516 ?? process.env.E2E_4511 ?? process.env.E2E_4502 ?? 4173)
// Share the selected lane port with every local fault host.
process.env.E2E_PORT = String(port)
// The web server's start includes the site build: minutes on a 4-vCPU box or a loaded host. E2E_SERVER_SECONDS sets it.
// Preview listens on 127.0.0.1, the address polled: a box resolves localhost to ::1 first, so it never answered there.
const serverMs = Number(process.env.E2E_SERVER_SECONDS ?? 600) * 1000

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/authbroker-setup.ts",
  reporter: [["list"], ["./e2e/coverage-reporter.ts"]],
  timeout: 30_000,
  // Keep the original three-browser concurrency as the suite gains files; this machine also runs other lanes.
  workers: 3,
  use: {
    baseURL: deployed ?? `http://127.0.0.1:${port}`,
    // A deployment runs the live agent; these suites test the mock (VL-13), which the page runs when this key asks.
    // Most cases are returning visitors; tour.spec.ts explicitly clears this flag for first-visit entry.
    storageState: { cookies: [], origins: [{ origin: new URL(deployed ?? `http://127.0.0.1:${port}`).origin, localStorage: [{ name: "vibelang:toured", value: "yes" }, ...(deployed === undefined ? [] : [{ name: "vibelang.agent", value: "mock" }])] }] },
    video: "retain-on-failure",
    trace: "retain-on-failure",
    // Chromium's RenderDocument gives each cross-document navigation a new frame and drops the old document's V8
    // coverage, so a test that loads two pages reported only the last (e2e/coverage-navigation.spec.ts, decision 0016).
    launchOptions: { args: ["--disable-features=RenderDocument"] },
  },
  projects: [
    { name: "dark", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "dark" } },
    // A visitor whose system prefers light still gets the dark page (wiki/decisions/0013-dark-only.md).
    { name: "light", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "light" } },
    { name: "phone", use: { ...devices["Pixel 7"], colorScheme: "dark" } },
  ],
  // The local e2e build also serves the fault-injection pages the recovery tests use, even when the rest run against a
  // deployment.
  webServer: { command: `pnpm build --mode e2e && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: serverMs },
})
