import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import { deleteApprovalRowsByWorkspaceId, findApprovalRow } from "@/db/repositories/approval-repository"
import { deleteWorkspaceRowById, insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { decideApproval, listApprovals, syncApprovalFromEvent } from "@/services/approval-service"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const originalFetch = globalThis.fetch
const workspaceIdsToDelete = new Set<string>()
const workspacePathsToDelete = new Set<string>()

function seedWorkspace(workspaceId = `test-workspace-${randomUUID()}`) {
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

describe("approval service", () => {
  it("returns an empty approval list for new workspaces", () => {
    const workspaceId = seedWorkspace()

    expect(listApprovals(workspaceId)).toEqual([])
  })

  it("syncs pending then approved approval events for the same node", () => {
    const workspaceId = seedWorkspace()

    const pending = syncApprovalFromEvent({
      workspaceId,
      runId: "run-123",
      nodeId: "deploy",
      status: "pending",
      message: "Waiting for operator",
    })

    expect(pending).toMatchObject({
      workspaceId,
      runId: "run-123",
      nodeId: "deploy",
      status: "pending",
    })

    const approved = syncApprovalFromEvent({
      workspaceId,
      runId: "run-123",
      nodeId: "deploy",
      status: "approved",
      message: "Approved",
    })

    expect(approved).toMatchObject({
      workspaceId,
      runId: "run-123",
      nodeId: "deploy",
      status: "approved",
      note: "Approved",
    })
    expect(typeof approved.decidedAt).toBe("string")
  })

  it("decides an approval by updating the existing row and forwarding the decision", async () => {
    const workspaceId = seedWorkspace()

    const seeded = syncApprovalFromEvent({
      workspaceId,
      runId: "run-9",
      nodeId: "deploy",
      status: "pending",
      message: "Awaiting review",
    })

    const capturedRequests: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      capturedRequests.push({ url, body })

      if (url.includes("/v1/runs/run-9/nodes/deploy/approve")) {
        return Response.json({ ok: true })
      }

      if (url.endsWith("/v1/runs/run-9")) {
        return Response.json({
          run: {
            id: "run-9",
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

      if (url.endsWith("/v1/runs/run-9/resume")) {
        return Response.json({
          run: {
            id: "run-9",
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

    const decided = await decideApproval({
      workspaceId,
      runId: "run-9",
      nodeId: "deploy",
      decision: "approved",
      input: {
        decidedBy: "lewi",
        note: "Ship it",
      },
    })

    expect(capturedRequests.some((request) => request.url.includes("/v1/runs/run-9/nodes/deploy/approve"))).toBe(true)
    expect(capturedRequests.some((request) => request.url.endsWith("/v1/runs/run-9/resume"))).toBe(
      true
    )
    expect(decided).toMatchObject({
      id: seeded.id,
      workspaceId,
      runId: "run-9",
      nodeId: "deploy",
      status: "approved",
      decidedBy: "lewi",
      note: "Ship it",
    })

    expect(findApprovalRow(workspaceId, "run-9", "deploy")).toMatchObject({
      id: seeded.id,
      status: "approved",
    })
  })
})
