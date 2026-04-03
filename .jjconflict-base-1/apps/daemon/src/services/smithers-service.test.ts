import { randomUUID } from "node:crypto"
import { lstatSync, mkdtempSync, readlinkSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "bun:test"

import { REPOSITORY_ROOT } from "@/config/paths"
import { deleteApprovalRowsByWorkspaceId, upsertApprovalRow } from "@/db/repositories/approval-repository"
import { deleteWorkspaceRowById, insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { getRun, listRuns, startRun } from "@/services/smithers-service"

const originalFetch = globalThis.fetch
const workspacePathsToDelete = new Set<string>()
const workspaceIdsToDelete = new Set<string>()

function createWorkspacePath() {
  const workspacePath = mkdtempSync(path.join(tmpdir(), "burns-smithers-service-"))
  workspacePathsToDelete.add(workspacePath)
  return workspacePath
}

function seedWorkspace(
  workspacePath: string,
  params: { runtimeMode?: "burns-managed" | "self-managed"; smithersBaseUrl?: string } = {}
) {
  const workspaceId = `test-workspace-${randomUUID()}`
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

  workspaceIdsToDelete.add(workspaceId)
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

describe("smithers service", () => {
  it("ensures workspace dependency resolution exists before starting a run", async () => {
    const workspacePath = createWorkspacePath()
    const workspaceId = seedWorkspace(workspacePath)

    globalThis.fetch = (async () =>
      Response.json({
        run: {
          id: "run-123",
          workflowId: "echo",
          workflowName: "echo",
          status: "running",
          startedAt: "2026-03-13T00:00:00.000Z",
          summary: {
            finished: 0,
            inProgress: 1,
            pending: 0,
          },
        },
      })) as unknown as typeof fetch

    const run = await startRun(workspaceId, {
      workflowId: "echo",
      input: { task: "hello" },
    })

    expect(run).toMatchObject({
      id: "run-123",
      workspaceId,
      workflowId: "echo",
      status: "running",
    })

    const nodeModulesPath = path.join(workspacePath, "node_modules")
    expect(lstatSync(nodeModulesPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(nodeModulesPath)).toBe(path.join(REPOSITORY_ROOT, "node_modules"))
  })

  it("derives workflow identity from workflow_path when smithers omits workflowId", async () => {
    const workspacePath = createWorkspacePath()
    const workspaceId = seedWorkspace(workspacePath)

    globalThis.fetch = (async () =>
      Response.json({
        run: {
          id: "run-456",
          workflow_path: path.join(workspacePath, ".smithers", "workflows", "echo-approve", "workflow.tsx"),
          status: "waiting-approval",
          startedAt: "2026-03-13T00:00:00.000Z",
          summary: {
            finished: 3,
            inProgress: 0,
            pending: 1,
          },
        },
      })) as unknown as typeof fetch

    const run = await startRun(workspaceId, {
      workflowId: "echo-approve",
      input: { request: "hello" },
    })

    expect(run).toMatchObject({
      id: "run-456",
      workflowId: "echo-approve",
      workflowName: "echo-approve",
      status: "waiting-approval",
      startedAt: "2026-03-13T00:00:00.000Z",
    })
  })

  it("starts self-managed runs using the discovered workflow entry file path", async () => {
    const workspacePath = createWorkspacePath()
    const workflowDirectoryPath = path.join(workspacePath, "smithers", "review")
    const workflowPath = path.join(workflowDirectoryPath, "workflow.tsx")
    const workspaceId = seedWorkspace(workspacePath, {
      runtimeMode: "self-managed",
      smithersBaseUrl: "http://127.0.0.1:8123",
    })

    mkdirSync(workflowDirectoryPath, { recursive: true })
    writeFileSync(
      workflowPath,
      `import { createSmithers } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  plan: z.object({ summary: z.string() }),
})

export default smithers(() => (
  <Workflow name="self-managed-review">
    <Task id="plan" output={outputs.plan}>
      {{ summary: "ready" }}
    </Task>
  </Workflow>
))
`,
      "utf8"
    )

    let requestBody: Record<string, unknown> | null = null

    globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(String(input)).toBe("http://127.0.0.1:8123/v1/runs")

      return Response.json({
        run: {
          id: "run-self-managed",
          workflowId: "smithers-review",
          workflowName: "self-managed-review",
          status: "running",
          startedAt: "2026-03-13T00:00:00.000Z",
          summary: {
            finished: 0,
            inProgress: 1,
            pending: 0,
          },
        },
      })
    }) as unknown as typeof fetch

    const run = await startRun(workspaceId, {
      workflowId: "smithers-review",
      input: { task: "hello" },
    })

    expect(requestBody).toMatchObject({
      workflowPath,
      input: { task: "hello" },
      config: {
        maxConcurrency: 4,
      },
      metadata: {
        workspaceId,
        workflowId: "smithers-review",
      },
    })
    expect(run).toMatchObject({
      id: "run-self-managed",
      workflowId: "smithers-review",
      workflowName: "self-managed-review",
      status: "running",
    })
  })

  it("maps millisecond timestamps from the smithers run list endpoint", async () => {
    const workspacePath = createWorkspacePath()
    const workspaceId = seedWorkspace(workspacePath)

    globalThis.fetch = (async () =>
      Response.json({
        runs: [
          {
            runId: "run-ms-list",
            workflowName: "workflow",
            workflowPath: path.join(workspacePath, ".smithers", "workflows", "echo", "workflow.tsx"),
            status: "finished",
            createdAtMs: 1773416127196,
            startedAtMs: 1773416127196,
            finishedAtMs: 1773416127215,
          },
        ],
      })) as unknown as typeof fetch

    const runs = await listRuns(workspaceId)

    expect(runs[0]).toMatchObject({
      id: "run-ms-list",
      startedAt: "2026-03-13T15:35:27.196Z",
      finishedAt: "2026-03-13T15:35:27.215Z",
    })
  })

  it("maps millisecond timestamps from the smithers run detail endpoint", async () => {
    const workspacePath = createWorkspacePath()
    const workspaceId = seedWorkspace(workspacePath)

    globalThis.fetch = (async () =>
      Response.json({
        run: {
          runId: "run-ms-detail",
          workflowName: "workflow",
          status: "waiting-approval",
          startedAtMs: 1773416946499,
          finishedAtMs: null,
          summary: {
            finished: 3,
            pending: 1,
          },
        },
      })) as unknown as typeof fetch

    const run = await getRun(workspaceId, "run-ms-detail")

    expect(run).toMatchObject({
      id: "run-ms-detail",
      startedAt: "2026-03-13T15:49:06.499Z",
      finishedAt: null,
    })
  })

  it("keeps waiting-approval runs paused until Smithers reports a resumed state", async () => {
    const workspacePath = createWorkspacePath()
    const workspaceId = seedWorkspace(workspacePath)

    upsertApprovalRow({
      id: `approval-${randomUUID()}`,
      workspaceId,
      runId: "run-789",
      nodeId: "approve",
      label: "approve",
      status: "approved",
      waitMinutes: 0,
      decidedAt: "2026-03-14T19:32:12.181Z",
      decidedBy: "Burns UI",
    })

    globalThis.fetch = (async () =>
      Response.json({
        runs: [
          {
            id: "run-789",
            workflowId: "echo-approve",
            workflowName: "echo-approve",
            status: "waiting-approval",
            startedAt: "2026-03-13T15:49:06.499Z",
            summary: {
              finished: 3,
              inProgress: 0,
              pending: 1,
            },
          },
        ],
      })) as unknown as typeof fetch

    const runs = await listRuns(workspaceId)

    expect(runs[0]).toMatchObject({
      id: "run-789",
      status: "waiting-approval",
      summary: {
        finished: 3,
        inProgress: 0,
        pending: 1,
      },
    })
  })

  it("keeps waiting-approval run detail paused until Smithers reports a resumed state", async () => {
    const workspacePath = createWorkspacePath()
    const workspaceId = seedWorkspace(workspacePath)

    upsertApprovalRow({
      id: `approval-${randomUUID()}`,
      workspaceId,
      runId: "run-999",
      nodeId: "approve",
      label: "approve",
      status: "approved",
      waitMinutes: 0,
      decidedAt: "2026-03-14T19:32:12.181Z",
      decidedBy: "Burns UI",
    })

    globalThis.fetch = (async () =>
      Response.json({
        run: {
          id: "run-999",
          workflowId: "echo-approve",
          workflowName: "echo-approve",
          status: "waiting-approval",
          startedAt: "2026-03-13T15:49:06.499Z",
          summary: {
            finished: 3,
            inProgress: 0,
            pending: 1,
          },
        },
      })) as unknown as typeof fetch

    const run = await getRun(workspaceId, "run-999")

    expect(run).toMatchObject({
      id: "run-999",
      status: "waiting-approval",
      summary: {
        finished: 3,
        inProgress: 0,
        pending: 1,
      },
    })
  })
})
