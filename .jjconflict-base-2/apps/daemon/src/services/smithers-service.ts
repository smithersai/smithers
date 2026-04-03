import path from "node:path"

import type { CancelRunInput, ResumeRunInput, Run, StartRunInput } from "@burns/shared"

import { listApprovalRowsByWorkspace } from "@/db/repositories/approval-repository"
import {
  cancelSmithersRun,
  createSmithersRun,
  getSmithersRun,
  listSmithersRuns,
  resumeSmithersRun,
  streamSmithersRunEvents,
} from "@/integrations/smithers/http-client"
import { ensureWorkspaceSmithersBaseUrl } from "@/services/smithers-instance-service"
import { ensureWorkspaceSmithersLayout } from "@/services/workspace-layout"
import {
  findWorkflowEntryByFilePath,
  repairLegacyDefaultWorkflowTemplate,
  resolveWorkflowEntryFilePath,
} from "@/services/workflow-service"
import { getWorkspace } from "@/services/workspace-service"
import { getSettings } from "@/services/settings-service"
import { HttpError } from "@/utils/http-error"

const EPOCH_ISO_TIMESTAMP = "1970-01-01T00:00:00.000Z"

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

function asIsoTimestamp(value: unknown) {
  const numericValue = asNumber(value)
  if (numericValue === undefined) {
    return undefined
  }

  const timestamp = new Date(numericValue).toISOString()
  return Number.isNaN(Date.parse(timestamp)) ? undefined : timestamp
}

function normalizeStatus(value: unknown): Run["status"] {
  const status = asString(value)
    ?.toLowerCase()
    .trim()
    .replaceAll("_", "-")
    .replaceAll(" ", "-")

  if (!status) {
    return "running"
  }

  if (
    status === "waiting-approval" ||
    status === "needs-approval" ||
    status === "pending-approval" ||
    status === "wait-approval" ||
    status === "awaiting-approval" ||
    status === "approval-required"
  ) {
    return "waiting-approval"
  }

  if (
    status === "finished" ||
    status === "completed" ||
    status === "success" ||
    status === "done"
  ) {
    return "finished"
  }

  if (status === "failed" || status === "error" || status === "errored") {
    return "failed"
  }

  if (status === "cancelled" || status === "canceled") {
    return "cancelled"
  }

  if (
    status === "running" ||
    status === "in-progress" ||
    status === "inprogress" ||
    status === "active"
  ) {
    return "running"
  }

  return "running"
}

function mapSummary(value: unknown): Run["summary"] {
  const source = asObject(value)
  return {
    finished:
      asNumber(source?.finished) ??
      asNumber(source?.done) ??
      asNumber(source?.completed) ??
      0,
    inProgress:
      asNumber(source?.inProgress) ??
      asNumber(source?.running) ??
      asNumber(source?.active) ??
      0,
    pending:
      asNumber(source?.pending) ??
      asNumber(source?.queued) ??
      asNumber(source?.waiting) ??
      0,
  }
}

function overrideStatusFromApprovals(
  run: Run,
  approvals: Array<{ runId: string; status: "pending" | "approved" | "denied" }>
) {
  if (run.status !== "waiting-approval") {
    return run
  }

  const runApprovals = approvals.filter((approval) => approval.runId === run.id)
  if (runApprovals.length === 0) {
    return run
  }

  if (runApprovals.some((approval) => approval.status === "pending")) {
    return run
  }

  if (runApprovals.some((approval) => approval.status === "denied")) {
    return {
      ...run,
      status: "failed",
      summary: {
        ...run.summary,
        pending: 0,
      },
    }
  }

  return run
}

function mapSmithersRun(workspaceId: string, payload: unknown): Run {
  const run = asObject(payload)
  const workflow = asObject(run?.workflow)
  const workflowRef = asObject(run?.workflowRef)
  const state = asObject(run?.state)
  const workflowPath =
    asString(run?.workflowPath) ??
    asString(run?.workflow_path) ??
    null
  const resolvedWorkflowFromPath = workflowPath ? findWorkflowEntryByFilePath(workspaceId, workflowPath) : null
  const workflowPathId = resolvedWorkflowFromPath?.id ?? (workflowPath ? path.basename(path.dirname(workflowPath)) : null)

  const workflowId =
    asString(run?.workflowId) ??
    asString(run?.workflow_id) ??
    asString(workflow?.id) ??
    asString(workflowRef?.id) ??
    workflowPathId ??
    resolvedWorkflowFromPath?.name ??
    asString(workflow?.name) ??
    "unknown-workflow"

  const workflowName =
    asString(run?.workflowName) ??
    resolvedWorkflowFromPath?.name ??
    asString(workflow?.name) ??
    workflowPathId ??
    workflowId

  const startedAt =
    asString(run?.startedAt) ??
    asIsoTimestamp(run?.startedAtMs) ??
    asIsoTimestamp(run?.started_at_ms) ??
    asIsoTimestamp(run?.createdAtMs) ??
    asIsoTimestamp(run?.created_at_ms) ??
    asString(run?.createdAt) ??
    asString(run?.updatedAt) ??
    EPOCH_ISO_TIMESTAMP

  const statusValue =
    asString(run?.status) ??
    asString(run?.stateKey) ??
    asString(run?.runState) ??
    asString(state?.key) ??
    asString(state?.status)

  return {
    id: asString(run?.runId) ?? asString(run?.id) ?? "unknown-run",
    workspaceId,
    workflowId,
    workflowName,
    status: normalizeStatus(statusValue),
    startedAt,
    finishedAt:
      asString(run?.finishedAt) ??
      asIsoTimestamp(run?.finishedAtMs) ??
      asIsoTimestamp(run?.finished_at_ms) ??
      asString(run?.endedAt) ??
      asString(run?.completedAt) ??
      null,
    summary: mapSummary(run?.summary),
  }
}

function unwrapRuns(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload
  }

  const objectPayload = asObject(payload)
  if (Array.isArray(objectPayload?.runs)) {
    return objectPayload.runs
  }

  return []
}

function unwrapRun(payload: unknown) {
  const objectPayload = asObject(payload)

  return asObject(objectPayload?.run) ?? objectPayload ?? payload
}

function assertWorkspace(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return workspace
}

function resolveManagedWorkflowPathFallback(workspacePath: string, workflowId: string) {
  return path.join(workspacePath, ".smithers", "workflows", workflowId, "workflow.tsx")
}

function resolveWorkflowPath(
  workspaceId: string,
  workspacePath: string,
  workflowId: string,
  options: { allowManagedFallback?: boolean } = {}
) {
  try {
    return resolveWorkflowEntryFilePath(workspaceId, workflowId)
  } catch (error) {
    if (options.allowManagedFallback && error instanceof HttpError && error.status === 404) {
      return resolveManagedWorkflowPathFallback(workspacePath, workflowId)
    }

    throw error
  }
}

function resolveWorkflowPathFromRun(
  workspaceId: string,
  workspacePath: string,
  run: unknown,
  options: { allowManagedFallback?: boolean } = {}
) {
  const runObject = asObject(run)
  const workflow = asObject(runObject?.workflow)
  const workflowRef = asObject(runObject?.workflowRef)

  const directWorkflowPath =
    asString(runObject?.workflowPath) ??
    asString(runObject?.workflow_path)

  if (directWorkflowPath) {
    return directWorkflowPath
  }

  const workflowId =
    asString(runObject?.workflowId) ??
    asString(runObject?.workflow_id) ??
    asString(workflow?.id) ??
    asString(workflowRef?.id)

  if (!workflowId) {
    return null
  }

  return resolveWorkflowPath(workspaceId, workspacePath, workflowId, options)
}

function getWorkflowIdFromRun(run: unknown) {
  const runObject = asObject(run)
  const workflow = asObject(runObject?.workflow)
  const workflowRef = asObject(runObject?.workflowRef)

  return (
    asString(runObject?.workflowId) ??
    asString(runObject?.workflow_id) ??
    asString(workflow?.id) ??
    asString(workflowRef?.id) ??
    null
  )
}

export async function listRuns(workspaceId: string) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const payload = await listSmithersRuns(baseUrl)
  const approvals = listApprovalRowsByWorkspace(workspaceId)
  return unwrapRuns(payload)
    .map((run) => mapSmithersRun(workspaceId, run))
    .map((run) => overrideStatusFromApprovals(run, approvals))
}

export async function getRun(workspaceId: string, runId: string) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const payload = await getSmithersRun(baseUrl, runId)
  const approvals = listApprovalRowsByWorkspace(workspaceId)
  return overrideStatusFromApprovals(mapSmithersRun(workspaceId, unwrapRun(payload)), approvals)
}

export async function startRun(workspaceId: string, input: StartRunInput) {
  const workspace = assertWorkspace(workspaceId)
  const settings = getSettings()
  ensureWorkspaceSmithersLayout(workspace.path)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  repairLegacyDefaultWorkflowTemplate(workspaceId, input.workflowId)
  const workflowPath = resolveWorkflowPath(workspaceId, workspace.path, input.workflowId, {
    allowManagedFallback: workspace.runtimeMode !== "self-managed",
  })

  const payload = await createSmithersRun(baseUrl, {
    workflowPath,
    input: input.input ?? {},
    config: {
      maxConcurrency: settings.maxConcurrency,
    },
    metadata: {
      workspaceId,
      workflowId: input.workflowId,
    },
  })

  return mapSmithersRun(workspaceId, unwrapRun(payload))
}

export async function resumeRun(workspaceId: string, runId: string, input: ResumeRunInput) {
  const workspace = assertWorkspace(workspaceId)
  const settings = getSettings()
  ensureWorkspaceSmithersLayout(workspace.path)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const existingRunPayload = await getSmithersRun(baseUrl, runId)
  const unwrappedRun = unwrapRun(existingRunPayload)
  const workflowId = getWorkflowIdFromRun(unwrappedRun)
  if (workflowId) {
    repairLegacyDefaultWorkflowTemplate(workspaceId, workflowId)
  }

  const resolvedWorkflowPath = resolveWorkflowPathFromRun(workspaceId, workspace.path, unwrappedRun, {
    allowManagedFallback: workspace.runtimeMode !== "self-managed",
  })

  if (!resolvedWorkflowPath) {
    throw new HttpError(422, `Unable to resolve workflowPath for run: ${runId}`)
  }

  const payload = await resumeSmithersRun(baseUrl, runId, {
    workflowPath: resolvedWorkflowPath,
    input: input.input ?? {},
    config: {
      maxConcurrency: settings.maxConcurrency,
    },
  })

  return mapSmithersRun(workspaceId, unwrapRun(payload))
}

export async function cancelRun(workspaceId: string, runId: string, input: CancelRunInput) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const payload = await cancelSmithersRun(baseUrl, runId, {
    reason: input.reason,
  })

  return mapSmithersRun(workspaceId, unwrapRun(payload))
}

export async function connectRunEventStream(
  workspaceId: string,
  runId: string,
  afterSeq?: number,
  signal?: AbortSignal
) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  return await streamSmithersRunEvents(baseUrl, runId, afterSeq, signal)
}
