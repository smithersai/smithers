import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.SMITHERS_REAL_PORT ?? "47321")
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`Invalid SMITHERS_REAL_PORT: ${process.env.SMITHERS_REAL_PORT}`)

const externalBaseURL = process.env.SMITHERS_REAL_BASE_URL
const baseURL = externalBaseURL ?? `http://127.0.0.1:${PORT}`
const expectedHost = process.env.SMITHERS_REAL_E2E_HOST ?? (externalBaseURL ? "production" : "local")
if (!["local", "production", "native"].includes(expectedHost)) throw new Error(`Invalid SMITHERS_REAL_E2E_HOST: ${expectedHost}`)
process.env.SMITHERS_REAL_E2E_HOST = expectedHost
const parsed = new URL(baseURL)
if (!/^https?:$/.test(parsed.protocol)) throw new Error(`SMITHERS_REAL_BASE_URL must use http(s): ${baseURL}`)

export default defineConfig({
  testDir: "e2e/real",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: "test-results/real-e2e-results.json" }], ["./e2e/real/coverage/reporter.ts"]]
    : [["list"], ["json", { outputFile: "test-results/real-e2e-results.json" }], ["./e2e/real/coverage/reporter.ts"]],
  outputDir: "test-results/real-e2e-artifacts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: parsed.toString(),
    headless: process.env.SMITHERS_REAL_HEADED !== "1",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: externalBaseURL ? undefined : {
    command: "bun scripts/run-real-e2e.ts serve",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      SMITHERS_REAL_PORT: String(PORT),
      SMITHERS_CHAT_STUB: "0"
    }
  }
})
