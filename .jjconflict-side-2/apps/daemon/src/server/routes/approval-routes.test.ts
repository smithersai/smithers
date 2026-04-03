import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import { deleteApprovalRowsByWorkspaceId } from "@/db/repositories/approval-repository"
import { deleteWorkspaceRowById, insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const originalFetch = globalThis.fetch
const workspaceIdsToDelete = new Set<string>()
const workspacePathsToDelete = new Set<string>()

function seedWorkspace() {
  const workspaceId = `test-workspace-${randomUUID()}`
  const now = new Date().toISOString()
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  mkdirSync(workspacePath, { recursive: true })
  workspaceIdsToDelete.add(workspaceId)
  workspacePathsToDelete.add(workspacePath)

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: workspacePath,
    sourceType: "create",
    runtimeMode: "self-managed",
    smithersBaseUrl: "http://127.0.0.1:8787",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  return workspaceId
}

afterEach(() => {
  globalThis.fetch = originalFetch

  for (const workspaceId of workspaceIdsToDelete) {
    deleteApprovalRowsByWorkspaceId(workspaceId)
    deleteWorkspaceRowById(workspaceId)
  }
  workspaceIdsToDelete.clear()

  for (const workspacePath of workspacePathsToDelete) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToDelete.clear()
})

describe("approval routes", () => {
  it("validates decision payloads", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/runs/run-1/nodes/deploy/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "missing decidedBy" }),
        }
      )
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "Invalid request",
    })
  })

  it("maps approval decisions and returns updated approval state", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const capturedUrls: string[] = []

    globalThis.fetch = (async (input: unknown) => {
      capturedUrls.push(String(input))
      return Response.json({
        ok: true,
      })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/runs/run-1/nodes/deploy/deny`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decidedBy: "lewi",
            note: "Needs additional verification",
          }),
        }
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId,
      runId: "run-1",
      nodeId: "deploy",
      status: "denied",
      decidedBy: "lewi",
      note: "Needs additional verification",
    })
    expect(capturedUrls.some((url) => url.includes("/v1/runs/run-1/nodes/deploy/deny"))).toBe(
      true
    )
  })

  it("approves and resumes the run before returning local approval state", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const capturedUrls: string[] = []

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      capturedUrls.push(url)

      if (url.includes("/v1/runs/run-1/nodes/deploy/approve")) {
        return Response.json({ ok: true })
      }

      if (url.endsWith("/v1/runs/run-1")) {
        return Response.json({
          run: {
            id: "run-1",
            workflowId: "echo-approve",
            workflowName: "echo-approve",
            workflowPath: `${resolveTestWorkspacePath(workspaceId)}/.smithers/workflows/echo-approve/workflow.tsx`,
            status: "waiting-approval",
            startedAt: "2026-03-13T15:49:06.499Z",
            summary: {
              finished: 3,
              inProgress: 0,
              pending: 1,
            },
          },
        })
      }

      if (url.endsWith("/v1/runs/run-1/resume")) {
        return Response.json({
          run: {
            id: "run-1",
            workflowId: "echo-approve",
            workflowName: "echo-approve",
            status: "running",
            startedAt: "2026-03-13T15:49:06.499Z",
            summary: {
              finished: 3,
              inProgress: 1,
              pending: 0,
            },
          },
        })
      }

      return Response.json({ ok: true })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/runs/run-1/nodes/deploy/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decidedBy: "lewi",
            note: "Ship it",
          }),
        }
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId,
      runId: "run-1",
      nodeId: "deploy",
      status: "approved",
      decidedBy: "lewi",
      note: "Ship it",
    })
    expect(capturedUrls.some((url) => url.includes("/v1/runs/run-1/nodes/deploy/approve"))).toBe(
      true
    )
    expect(capturedUrls.some((url) => url.endsWith("/v1/runs/run-1/resume"))).toBe(true)
  })
})
