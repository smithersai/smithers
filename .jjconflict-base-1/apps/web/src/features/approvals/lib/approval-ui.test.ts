import { describe, expect, it } from "bun:test"

import type { Approval, Workspace } from "@burns/shared"

import {
  buildPendingApprovalInboxItems,
  getApprovalConfirmationState,
  sortApprovals,
} from "./approval-ui"

function makeApproval(overrides: Partial<Approval> & Pick<Approval, "id" | "workspaceId" | "runId" | "nodeId" | "label" | "status" | "waitMinutes">): Approval {
  return {
    note: undefined,
    decidedAt: undefined,
    decidedBy: undefined,
    ...overrides,
  }
}

const workspaces: Workspace[] = [
  {
    id: "burns-web-app",
    name: "Burns Web App",
    path: "/tmp/burns-web-app",
    sourceType: "local",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: "2026-03-13T15:00:00.000Z",
    updatedAt: "2026-03-13T15:00:00.000Z",
  },
  {
    id: "ops-console",
    name: "Ops Console",
    path: "/tmp/ops-console",
    sourceType: "local",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: "2026-03-13T15:00:00.000Z",
    updatedAt: "2026-03-13T15:00:00.000Z",
  },
]

describe("approval UI helpers", () => {
  it("maps approval statuses to confirmation component states", () => {
    expect(getApprovalConfirmationState("pending")).toBe("approval-requested")
    expect(getApprovalConfirmationState("approved")).toBe("output-available")
    expect(getApprovalConfirmationState("denied")).toBe("output-denied")
  })

  it("builds global inbox items for pending approvals only", () => {
    const items = buildPendingApprovalInboxItems(workspaces, {
      "burns-web-app": [
        makeApproval({
          id: "approval-1",
          workspaceId: "burns-web-app",
          runId: "run-1",
          nodeId: "deploy",
          label: "Deploy approval",
          status: "pending",
          waitMinutes: 8,
        }),
      ],
      "ops-console": [
        makeApproval({
          id: "approval-2",
          workspaceId: "ops-console",
          runId: "run-2",
          nodeId: "qa",
          label: "QA gate",
          status: "approved",
          waitMinutes: 1,
        }),
      ],
    })

    expect(items).toEqual([
      expect.objectContaining({
        id: "approval-1",
        workspaceName: "Burns Web App",
        runHref: "/w/burns-web-app/runs/run-1",
      }),
    ])
  })

  it("sorts approval cards by wait time and update timestamps", () => {
    const approvals = [
      makeApproval({
        id: "approval-1",
        workspaceId: "burns-web-app",
        runId: "run-1",
        nodeId: "deploy",
        label: "Deploy approval",
        status: "pending",
        waitMinutes: 2,
      }),
      makeApproval({
        id: "approval-2",
        workspaceId: "burns-web-app",
        runId: "run-2",
        nodeId: "release",
        label: "Release approval",
        status: "approved",
        waitMinutes: 9,
        decidedAt: "2026-03-13T16:00:00.000Z",
      }),
      makeApproval({
        id: "approval-3",
        workspaceId: "burns-web-app",
        runId: "run-3",
        nodeId: "rollback",
        label: "Rollback approval",
        status: "denied",
        waitMinutes: 4,
        decidedAt: "2026-03-13T16:10:00.000Z",
      }),
    ]

    expect(sortApprovals(approvals, "wait-desc").map((approval) => approval.id)).toEqual([
      "approval-2",
      "approval-3",
      "approval-1",
    ])
    expect(sortApprovals(approvals, "updated-desc").map((approval) => approval.id)).toEqual([
      "approval-3",
      "approval-2",
      "approval-1",
    ])
  })
})
