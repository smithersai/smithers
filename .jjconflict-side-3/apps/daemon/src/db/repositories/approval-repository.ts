import type { Approval } from "@burns/shared"

import { db } from "@/db/client"

type ApprovalRow = {
  id: string
  workspace_id: string
  run_id: string
  node_id: string
  label: string
  status: Approval["status"]
  wait_minutes: number
  note: string | null
  decided_by: string | null
  decided_at: string | null
}

function mapApprovalRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    nodeId: row.node_id,
    label: row.label,
    status: row.status,
    waitMinutes: row.wait_minutes,
    note: row.note ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ?? undefined,
  }
}

export function listApprovalRowsByWorkspace(workspaceId: string) {
  const rows = db
    .query<ApprovalRow, [string]>(
      `
        SELECT
          id,
          workspace_id,
          run_id,
          node_id,
          label,
          status,
          wait_minutes,
          note,
          decided_by,
          decided_at
        FROM approvals
        WHERE workspace_id = ?1
        ORDER BY status = 'pending' DESC, updated_at DESC
      `
    )
    .all(workspaceId)

  return rows.map(mapApprovalRow)
}

export function findApprovalRow(workspaceId: string, runId: string, nodeId: string) {
  const row = db
    .query<ApprovalRow, [string, string, string]>(
      `
        SELECT
          id,
          workspace_id,
          run_id,
          node_id,
          label,
          status,
          wait_minutes,
          note,
          decided_by,
          decided_at
        FROM approvals
        WHERE workspace_id = ?1
          AND run_id = ?2
          AND node_id = ?3
      `
    )
    .get(workspaceId, runId, nodeId)

  return row ? mapApprovalRow(row) : null
}

export function upsertApprovalRow(approval: Approval) {
  const now = new Date().toISOString()

  db
    .query(
      `
        INSERT INTO approvals (
          id,
          workspace_id,
          run_id,
          node_id,
          label,
          status,
          wait_minutes,
          note,
          decided_by,
          decided_at,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(workspace_id, run_id, node_id)
        DO UPDATE SET
          label = excluded.label,
          status = excluded.status,
          wait_minutes = excluded.wait_minutes,
          note = excluded.note,
          decided_by = excluded.decided_by,
          decided_at = excluded.decided_at,
          updated_at = excluded.updated_at
      `
    )
    .run(
      approval.id,
      approval.workspaceId,
      approval.runId,
      approval.nodeId,
      approval.label,
      approval.status,
      approval.waitMinutes,
      approval.note ?? null,
      approval.decidedBy ?? null,
      approval.decidedAt ?? null,
      now,
      now
    )

  return findApprovalRow(approval.workspaceId, approval.runId, approval.nodeId)
}

export function countApprovalRows() {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM approvals`).get()
  return row?.count ?? 0
}

export function deleteApprovalRowsByWorkspaceId(workspaceId: string) {
  const result = db
    .query(
      `
        DELETE FROM approvals
        WHERE workspace_id = ?1
      `
    )
    .run(workspaceId)

  return result.changes
}
