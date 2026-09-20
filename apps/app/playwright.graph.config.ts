import { defineConfig, devices } from "@playwright/test"

/*
 * The flow-graph tier: the app, a real control plane and a real engine, on
 * localhost, in Chromium, with nothing intercepted.
 *
 *   pnpm --filter smithers-app exec playwright test --config playwright.graph.config.ts
 *
 * The web server is the one command `e2e/graph/README.md` documents
 * (`scripts/flow-graph-e2e-host.ts`): it builds the SPA, starts the gateway
 * half under tsx/Node, and serves the origin. Nothing here needs a GitHub
 * session, a Smithers Cloud workspace or a provider key.
 */
const PORT = Number(process.env.SMITHERS_FLOW_GRAPH_PORT ?? "47331")
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid SMITHERS_FLOW_GRAPH_PORT: ${process.env.SMITHERS_FLOW_GRAPH_PORT}`)
}
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: "e2e/graph",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  // A real plan crosses the relay, the control plane and the engine, and the
  // first run of the tier builds the SPA before any of that.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "flow-graph" }],
  webServer: {
    command: "bun scripts/flow-graph-e2e-host.ts",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    // The host owns detached groups and must finish its Effect finalizers.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 300_000,
    env: { SMITHERS_FLOW_GRAPH_PORT: String(PORT) }
  }
})
