import { randomUUID } from "node:crypto"

import type { Approval, ApprovalDecisionInput } from "@burns/shared"

import {
  findApprovalRow,
  listApprovalRowsByWorkspace,
  upsertApprovalRow,
} from "@/db/repositories/approval-repository"
import { approveSmithersNode, denySmithersNode } from "@/integrations/smithers/http-client"
import { appendRunEvent } from "@/services/run-event-service"
import { resumeRun as resumeSmithersWorkflowRun } from "@/services/smithers-service"
import { ensureWorkspaceSmithersBaseUrl } from "@/services/smithers-instance-service"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"

function assertWorkspaceExists(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return workspace
}

function ensurePendingApproval(params: {
  workspaceId: string
  runId: string
  nodeId: string
  label?: string
  note?: string
}) {
  const existing = findApprovalRow(params.workspaceId, params.runId, params.nodeId)
  if (existing) {
    return existing
  }

  return upsertApprovalRow({
    id: `approval-${randomUUID()}`,
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
    label: params.label ?? params.nodeId,
    status: "pending",
    waitMinutes: 0,
    note: params.note,
  })!
}

export function listApprovals(workspaceId: string) {
  assertWorkspaceExists(workspaceId)
  return listApprovalRowsByWorkspace(workspaceId)
}

export function upsertPendingApproval(params: {
  workspaceId: string
  runId: string
  nodeId: string
  label?: string
  note?: string
}) {
  assertWorkspaceExists(params.workspaceId)
  return ensurePendingApproval(params)
}

export function syncApprovalFromEvent(params: {
  workspaceId: string
  runId: string
  nodeId: string
  status: "pending" | "approved" | "denied"
  message?: string
}) {
  assertWorkspaceExists(params.workspaceId)

  const existing = ensurePendingApproval({
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
    label: params.nodeId,
    note: params.message,
  })

  if (params.status === "pending") {
    return existing
  }

  return upsertApprovalRow({
    ...existing,
    status: params.status,
    note: params.message ?? existing.note,
    decidedAt: new Date().toISOString(),
  })!
}

export async function decideApproval(params: {
  workspaceId: string
  runId: string
  nodeId: string
  decision: "approved" | "denied"
  input: ApprovalDecisionInput
}) {
  const workspace = assertWorkspaceExists(params.workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const existingApproval = ensurePendingApproval({
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
  })

  const payload = {
    note: params.input.note,
    decidedBy: params.input.decidedBy,
  }

  if (params.decision === "approved") {
    await approveSmithersNode(baseUrl, params.runId, params.nodeId, payload)
  } else {
    await denySmithersNode(baseUrl, params.runId, params.nodeId, payload)
  }

  const decidedAt = new Date().toISOString()
  const updatedApproval = upsertApprovalRow({
    id: existingApproval.id,
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
    label: params.nodeId,
    status: params.decision === "approved" ? "approved" : "denied",
    waitMinutes: 0,
    note: params.input.note,
    decidedBy: params.input.decidedBy,
    decidedAt,
  })

  if (!updatedApproval) {
    throw new HttpError(500, "Failed to persist approval decision")
  }

  appendRunEvent(params.workspaceId, params.runId, {
    type: params.decision === "approved" ? "approval.approved" : "approval.denied",
    timestamp: decidedAt,
    nodeId: params.nodeId,
    message:
      params.input.note ??
      `${params.input.decidedBy} ${params.decision === "approved" ? "approved" : "denied"} node ${params.nodeId}`,
  })

  if (params.decision === "approved") {
    await resumeSmithersWorkflowRun(params.workspaceId, params.runId, {})
  }

  return updatedApproval
}
