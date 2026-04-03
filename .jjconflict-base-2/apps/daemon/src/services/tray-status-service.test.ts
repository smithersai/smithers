import { describe, expect, it } from "bun:test"

import type { Approval, Run, Workspace } from "@burns/shared"

import { getTrayStatus } from "./tray-status-service"

const NOW_ISO = "2026-03-14T12:00:00.000Z"

function buildWorkspace(workspaceId: string): Workspace {
  return {
    id: workspaceId,
    name: workspaceId,
    path: `/tmp/${workspaceId}`,
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  }
}

function buildRun(workspaceId: string, runId: string, status: Run["status"]): Run {
  return {
    id: runId,
    workspaceId,
    workflowId: "workflow",
    workflowName: "workflow",
    status,
    startedAt: NOW_ISO,
    finishedAt: null,
    summary: {
      finished: 0,
      inProgress: status === "running" ? 1 : 0,
      pending: status === "waiting-approval" ? 1 : 0,
    },
  }
}

function buildApproval(
  workspaceId: string,
  runId: string,
  nodeId: string,
  status: Approval["status"]
): Approval {
  return {
    id: `approval-${workspaceId}-${runId}-${nodeId}`,
    workspaceId,
    runId,
    nodeId,
    label: nodeId,
    status,
    waitMinutes: 0,
  }
}

describe("tray status service", () => {
  it("returns zero counts when no workspaces are registered", async () => {
    const trayStatus = await getTrayStatus({
      listWorkspaces: () => [],
      listRuns: async () => [],
      listApprovals: () => [],
    })

    expect(trayStatus).toEqual({
      pendingCount: 0,
      runningCount: 0,
      pendingTarget: null,
    })
  })

  it("returns a direct run target when exactly one pending approval exists", async () => {
    const trayStatus = await getTrayStatus({
      listWorkspaces: () => [buildWorkspace("workspace-1")],
      listRuns: async () => [buildRun("workspace-1", "run-1", "running")],
      listApprovals: (workspaceId) => [buildApproval(workspaceId, "run-1", "deploy", "pending")],
    })

    expect(trayStatus).toEqual({
      pendingCount: 1,
      runningCount: 1,
      pendingTarget: {
        kind: "run",
        workspaceId: "workspace-1",
        runId: "run-1",
      },
    })
  })

  it("returns the inbox target when multiple pending approvals exist", async () => {
    const trayStatus = await getTrayStatus({
      listWorkspaces: () => [buildWorkspace("workspace-1"), buildWorkspace("workspace-2")],
      listRuns: async (workspaceId) =>
        workspaceId === "workspace-1"
          ? [buildRun("workspace-1", "run-1", "running")]
          : [buildRun("workspace-2", "run-2", "running")],
      listApprovals: (workspaceId) =>
        workspaceId === "workspace-1"
          ? [buildApproval(workspaceId, "run-1", "deploy", "pending")]
          : [buildApproval(workspaceId, "run-2", "review", "pending")],
    })

    expect(trayStatus).toEqual({
      pendingCount: 2,
      runningCount: 2,
      pendingTarget: {
        kind: "inbox",
      },
    })
  })

  it("counts only running runs and ignores failed workspace run fetches", async () => {
    const trayStatus = await getTrayStatus({
      listWorkspaces: () => [buildWorkspace("workspace-1"), buildWorkspace("workspace-2")],
      listRuns: async (workspaceId) => {
        if (workspaceId === "workspace-2") {
          throw new Error("workspace offline")
        }

        return [
          buildRun("workspace-1", "run-1", "running"),
          buildRun("workspace-1", "run-2", "finished"),
          buildRun("workspace-1", "run-3", "waiting-approval"),
        ]
      },
      listApprovals: () => [],
    })

    expect(trayStatus).toEqual({
      pendingCount: 0,
      runningCount: 1,
      pendingTarget: null,
    })
  })
})
