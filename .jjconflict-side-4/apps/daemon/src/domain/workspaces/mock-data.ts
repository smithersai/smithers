import type { Approval, Run, Workspace } from "@burns/shared"

export const workspaces: Workspace[] = [
  {
    id: "burns-web-app",
    name: "burns-web-app",
    path: "/Users/lewi/Documents/Burns/burns-web-app",
    branch: "main",
    repoUrl: "github.com/acme/burns-web-app",
    defaultAgent: "Claude Code",
    healthStatus: "healthy",
    sourceType: "create",
    runtimeMode: "burns-managed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

export const runs: Run[] = [
  {
    id: "smi_abc123",
    workspaceId: "burns-web-app",
    workflowId: "issue-to-pr",
    workflowName: "issue-to-pr",
    status: "running",
    startedAt: new Date().toISOString(),
    summary: {
      finished: 3,
      inProgress: 1,
      pending: 2,
    },
  },
  {
    id: "smi_qwe998",
    workspaceId: "burns-web-app",
    workflowId: "pr-feedback",
    workflowName: "pr-feedback",
    status: "waiting-approval",
    startedAt: new Date().toISOString(),
    summary: {
      finished: 5,
      inProgress: 0,
      pending: 1,
    },
  },
]

export const approvals: Approval[] = [
  {
    id: "approval-deploy",
    workspaceId: "burns-web-app",
    runId: "smi_qwe998",
    nodeId: "deploy",
    label: "deploy",
    status: "pending",
    waitMinutes: 18,
    note: "CI passed. Waiting for operator approval.",
  },
]
