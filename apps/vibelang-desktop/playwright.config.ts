// Stays .ts: Playwright loads configurations and discovers tests by JS/TS extension only.
import { defineConfig } from "@playwright/test"
export default defineConfig({ testDir: "e2e", workers: 1, timeout: 120000, expect: { timeout: 15000 }, use: { trace: "retain-on-failure" } })
