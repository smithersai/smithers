import { describe, expect, it } from "bun:test"

import { handleSystemRoutes } from "@/server/routes/system-routes"

describe("handleSystemRoutes", () => {
  it("returns selected path for localhost requests", async () => {
    const response = await handleSystemRoutes(
      new Request("http://localhost:7332/api/system/folder-picker", { method: "POST" }),
      "/api/system/folder-picker",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ path: "/Users/alex/code/repo" })
  })

  it("blocks non-localhost requests", async () => {
    const response = await handleSystemRoutes(
      new Request("http://example.com/api/system/folder-picker", { method: "POST" }),
      "/api/system/folder-picker",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )

    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({
      error: "Native folder picker is only available on localhost daemon URLs",
      details: null,
    })
  })

  it("returns null for non-matching routes or methods", async () => {
    const methodMismatch = await handleSystemRoutes(
      new Request("http://localhost:7332/api/system/folder-picker", { method: "GET" }),
      "/api/system/folder-picker",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )
    expect(methodMismatch).toBeNull()

    const pathMismatch = await handleSystemRoutes(
      new Request("http://localhost:7332/api/system/unknown", { method: "POST" }),
      "/api/system/unknown",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )
    expect(pathMismatch).toBeNull()
  })

  it("validates Smithers URL reachability", async () => {
    const response = await handleSystemRoutes(
      new Request("http://localhost:7332/api/system/validate-smithers-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "http://localhost:7331" }),
      }),
      "/api/system/validate-smithers-url",
      {
        validateSmithersUrl: async (baseUrl) => ({
          ok: true,
          status: 200,
          message: `validated ${baseUrl}`,
        }),
      }
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      ok: true,
      status: 200,
      message: "validated http://localhost:7331",
    })
  })

  it("returns aggregate tray status", async () => {
    const response = await handleSystemRoutes(
      new Request("http://localhost:7332/api/system/tray-status", {
        method: "GET",
      }),
      "/api/system/tray-status",
      {
        getTrayStatus: async () => ({
          pendingCount: 1,
          runningCount: 2,
          pendingTarget: {
            kind: "run",
            workspaceId: "workspace-1",
            runId: "run-1",
          },
        }),
      }
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      pendingCount: 1,
      runningCount: 2,
      pendingTarget: {
        kind: "run",
        workspaceId: "workspace-1",
        runId: "run-1",
      },
    })
  })
})
