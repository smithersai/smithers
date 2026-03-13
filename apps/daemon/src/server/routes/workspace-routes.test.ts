import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const originalFetch = globalThis.fetch
const workspacePathsToDelete = new Set<string>()

function seedWorkspace(params: {
  runtimeMode?: "burns-managed" | "self-managed"
  smithersBaseUrl?: string
} = {}) {
  const workspaceId = `test-workspace-${randomUUID()}`
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: workspacePath,
    sourceType: "create",
    runtimeMode: params.runtimeMode ?? "burns-managed",
    smithersBaseUrl: params.smithersBaseUrl,
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  workspacePathsToDelete.add(workspacePath)
  return workspaceId
}

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const workspacePath of workspacePathsToDelete) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToDelete.clear()
})

describe("workspace routes", () => {
  it("returns workspace server status", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/server/status`, {
        method: "GET",
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId,
      processState: "disabled",
    })
  })

  it("returns effective workspace runtime config", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace({
      runtimeMode: "self-managed",
      smithersBaseUrl: "http://127.0.0.1:8123",
    })

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runtime-config`, {
        method: "GET",
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId,
      workspaceRuntimeMode: "self-managed",
      managementMode: "self-managed",
      baseUrl: "http://127.0.0.1:8123",
      baseUrlSource: "workspace",
      canAutoRestart: false,
    })
  })

  it("supports server control actions", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    for (const action of ["start", "restart", "stop"] as const) {
      const response = await app.fetch(
        new Request(`http://localhost:7332/api/workspaces/${workspaceId}/server/${action}`, {
          method: "POST",
        })
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        workspaceId,
        processState: "disabled",
      })
    }
  })

  it("returns 404 for server routes when workspace does not exist", async () => {
    const app = createApp()
    const missingWorkspaceId = `missing-${randomUUID()}`

    const statusResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${missingWorkspaceId}/server/status`, {
        method: "GET",
      })
    )
    expect(statusResponse.status).toBe(404)

    const actionResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${missingWorkspaceId}/server/start`, {
        method: "POST",
      })
    )
    expect(actionResponse.status).toBe(404)
  })

  it("probes self-managed heartbeat in workspace server status route", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace({
      runtimeMode: "self-managed",
      smithersBaseUrl: "http://127.0.0.1:8123",
    })
    globalThis.fetch = (async () => Response.json({ runs: [] })) as unknown as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/server/status`, {
        method: "GET",
      })
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      processState: string
      runtimeMode: string
      lastHeartbeatAt: string | null
      baseUrl: string | null
    }
    expect(payload.processState).toBe("self-managed")
    expect(payload.runtimeMode).toBe("self-managed")
    expect(payload.baseUrl).toBe("http://127.0.0.1:8123")
    expect(typeof payload.lastHeartbeatAt).toBe("string")
  })

  it("unlinks a workspace without deleting files", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const workspacePath = resolveTestWorkspacePath(workspaceId)
    mkdirSync(workspacePath, { recursive: true })

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "unlink" }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId,
      mode: "unlink",
      filesDeleted: false,
    })
    expect(existsSync(workspacePath)).toBe(true)

    const detailResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}`, {
        method: "GET",
      })
    )
    expect(detailResponse.status).toBe(404)
  })

  it("deletes a workspace and removes files", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const workspacePath = resolveTestWorkspacePath(workspaceId)
    mkdirSync(workspacePath, { recursive: true })

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "delete" }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId,
      mode: "delete",
      filesDeleted: true,
    })
    expect(existsSync(workspacePath)).toBe(false)
  })

  it("returns 400 for invalid workspace delete modes", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "invalid" }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "Invalid request",
    })
  })

  it("returns 404 when deleting a missing workspace", async () => {
    const app = createApp()
    const missingWorkspaceId = `missing-${randomUUID()}`

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${missingWorkspaceId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "unlink" }),
      })
    )

    expect(response.status).toBe(404)
  })
})
