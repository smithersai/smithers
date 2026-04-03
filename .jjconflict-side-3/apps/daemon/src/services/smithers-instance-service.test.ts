import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import {
  getWorkspaceSmithersServerStatus,
  restartWorkspaceSmithersServer,
  startWorkspaceSmithersServer,
  stopWorkspaceSmithersServer,
} from "@/services/smithers-instance-service"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const originalFetch = globalThis.fetch

function seedWorkspace(params: { runtimeMode: "burns-managed" | "self-managed"; smithersBaseUrl?: string }) {
  const workspaceId = `test-workspace-${randomUUID()}`
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: resolveTestWorkspacePath(workspaceId),
    sourceType: "create",
    runtimeMode: params.runtimeMode,
    smithersBaseUrl: params.smithersBaseUrl,
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  return workspaceId
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("smithers instance service workspace operations", () => {
  it("returns self-managed status payload details with heartbeat", async () => {
    const workspaceId = seedWorkspace({
      runtimeMode: "self-managed",
      smithersBaseUrl: "http://127.0.0.1:8123",
    })
    globalThis.fetch = (async () => Response.json({ runs: [] })) as unknown as typeof fetch

    const status = await getWorkspaceSmithersServerStatus(workspaceId)

    expect(status).toMatchObject({
      workspaceId,
      runtimeMode: "self-managed",
      processState: "self-managed",
      restartCount: 0,
      crashCount: 0,
      port: 8123,
      baseUrl: "http://127.0.0.1:8123",
    })
    expect(typeof status.lastHeartbeatAt).toBe("string")
  })

  it("treats self-managed control actions as non-destructive no-ops", async () => {
    const workspaceId = seedWorkspace({
      runtimeMode: "self-managed",
      smithersBaseUrl: "https://smithers.example.com",
    })
    globalThis.fetch = (async () => Response.json({ runs: [] })) as unknown as typeof fetch

    const started = await startWorkspaceSmithersServer(workspaceId)
    const restarted = await restartWorkspaceSmithersServer(workspaceId)
    const stopped = await stopWorkspaceSmithersServer(workspaceId)

    for (const status of [started, restarted, stopped]) {
      expect(status).toMatchObject({
        workspaceId,
        runtimeMode: "self-managed",
        processState: "self-managed",
        restartCount: 0,
        crashCount: 0,
      })
      expect(typeof status.lastHeartbeatAt).toBe("string")
    }
  })

  it("returns null self-managed heartbeat when endpoint is unreachable", async () => {
    const workspaceId = seedWorkspace({
      runtimeMode: "self-managed",
      smithersBaseUrl: "https://smithers.example.com",
    })
    globalThis.fetch = (async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch

    const status = await getWorkspaceSmithersServerStatus(workspaceId)

    expect(status).toMatchObject({
      workspaceId,
      runtimeMode: "self-managed",
      processState: "self-managed",
      lastHeartbeatAt: null,
    })
  })

  it("returns disabled managed status in test runtime", async () => {
    const workspaceId = seedWorkspace({ runtimeMode: "burns-managed" })

    const status = await startWorkspaceSmithersServer(workspaceId)

    expect(status).toMatchObject({
      workspaceId,
      runtimeMode: "burns-managed",
      processState: "disabled",
      lastHeartbeatAt: null,
      restartCount: 0,
      crashCount: 0,
      port: 7331,
      baseUrl: "http://localhost:7331",
    })
  })
})
