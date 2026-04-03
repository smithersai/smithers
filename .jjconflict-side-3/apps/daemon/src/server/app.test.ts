import { afterEach, describe, expect, it } from "bun:test"

import { createApp } from "./app"
import { clearSettingsForTests } from "@/services/settings-service"

afterEach(() => {
  clearSettingsForTests()
})

describe("daemon route method guards", () => {
  it("returns 404 for non-GET requests on read-only routes", async () => {
    const app = createApp()
    const postOnlyPaths = [
      "/api/workspaces/workspace-1/approvals",
      "/api/settings",
      "/api/doctor",
      "/api/agents/clis",
    ]

    for (const path of postOnlyPaths) {
      const response = await app.fetch(new Request(`http://localhost:7332${path}`, { method: "POST" }))
      expect(response.status).toBe(404)
    }
  })

  it("still serves GET requests on read-only routes", async () => {
    const app = createApp()

    const response = await app.fetch(new Request("http://localhost:7332/api/settings", { method: "GET" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      allowNetwork: false,
      maxConcurrency: 4,
      maxBodyBytes: 1048576,
      smithersAuthMode: "bearer",
      rootDirPolicy: "workspace-root",
    })
  })
})
