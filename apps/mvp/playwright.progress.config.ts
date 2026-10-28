import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

// Background progress (decision 0124) in both real engines: the normal target, sign-in, fault declarations, watchers
// and recordings, with only the three progress specs, in Chromium and WebKit.
const setup = base.projects!.filter((project) => project.name === "deployment-auth" || project.name === "local-setup")
const target = base.projects!.find((project) => project.name === "deployment" || project.name === "local")!
export default defineConfig({
  ...base,
  projects: [
    ...setup,
    ...(["chromium", "webkit"] as const).map((browserName) => ({
      name: `progress-${browserName}`,
      dependencies: setup.map((project) => project.name!),
      testMatch: /(?:background|issue|todo)-progress\.spec\.ts$/,
      use: { ...target.use, browserName },
    })),
  ],
})
