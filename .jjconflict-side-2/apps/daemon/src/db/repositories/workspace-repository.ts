import type { Workspace } from "@burns/shared"

import { db } from "@/db/client"

type WorkspaceRow = {
  id: string
  name: string
  path: string
  branch: string | null
  repo_url: string | null
  default_agent: string | null
  health_status: Workspace["healthStatus"]
  source_type: Workspace["sourceType"]
  runtime_mode: Workspace["runtimeMode"]
  smithers_base_url: string | null
  created_at: string
  updated_at: string
}

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    branch: row.branch ?? undefined,
    repoUrl: row.repo_url ?? undefined,
    defaultAgent: row.default_agent ?? undefined,
    healthStatus: row.health_status,
    sourceType: row.source_type,
    runtimeMode: row.runtime_mode,
    smithersBaseUrl: row.smithers_base_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listWorkspaceRows() {
  const rows = db
    .query<WorkspaceRow, []>(
      `
        SELECT
          id,
          name,
          path,
          branch,
          repo_url,
          default_agent,
          health_status,
          source_type,
          runtime_mode,
          smithers_base_url,
          created_at,
          updated_at
        FROM workspaces
        ORDER BY created_at ASC
      `
    )
    .all()

  return rows.map(mapWorkspaceRow)
}

export function findWorkspaceRowById(id: string) {
  const row = db
    .query<WorkspaceRow, [string]>(
      `
        SELECT
          id,
          name,
          path,
          branch,
          repo_url,
          default_agent,
          health_status,
          source_type,
          runtime_mode,
          smithers_base_url,
          created_at,
          updated_at
        FROM workspaces
        WHERE id = ?1
      `
    )
    .get(id)

  return row ? mapWorkspaceRow(row) : null
}

export function insertWorkspaceRow(workspace: Workspace) {
  db
    .query(
      `
        INSERT INTO workspaces (
          id,
          name,
          path,
          branch,
          repo_url,
          default_agent,
          health_status,
          source_type,
          runtime_mode,
          smithers_base_url,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      `
    )
    .run(
      workspace.id,
      workspace.name,
      workspace.path,
      workspace.branch ?? null,
      workspace.repoUrl ?? null,
      workspace.defaultAgent ?? null,
      workspace.healthStatus,
      workspace.sourceType,
      workspace.runtimeMode,
      workspace.smithersBaseUrl ?? null,
      workspace.createdAt,
      workspace.updatedAt
    )

  return workspace
}

export function countWorkspaces() {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM workspaces`).get()
  return row?.count ?? 0
}

export function deleteWorkspaceRowById(workspaceId: string) {
  const result = db
    .query(
      `
        DELETE FROM workspaces
        WHERE id = ?1
      `
    )
    .run(workspaceId)

  return result.changes
}
