/**
 * Durable workspace routing shared by the CLI and every engine host.
 * @since 1.0.0
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { databasePath } from "../internal/ControlDatabasePath.ts"
import { executionDatabasePath } from "../internal/ExecutionDatabasePath.ts"
import { hasTable } from "../internal/SqliteTable.ts"

interface ResolvedWorkspace {
  readonly path: string
  readonly boundRunId?: string
}

const resolveWorkspace = (root: string, runId: string): ResolvedWorkspace | undefined => {
  const file = executionDatabasePath(root)
  if (!existsSync(file)) return { path: resolve(root) }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const routes = hasTable(db, "smthrs_history_workspaces")
    const edges = hasTable(db, "flows_time_travel_edges")
    const seen = new Set<string>()
    let id: string | null = runId
    while (id !== null) {
      if (seen.has(id)) throw new Error(`Cyclic run ancestry at ${id}`)
      seen.add(id)
      if (routes) {
        const route = db.prepare("SELECT workspace FROM smthrs_history_workspaces WHERE run_id=?").get(id)
        if (route !== undefined) return { path: resolve(String(route.workspace)), boundRunId: id }
      }
      if (edges && db.prepare("SELECT 1 FROM flows_time_travel_edges WHERE child_run_id=? AND kind='fork'").get(id)) {
        return undefined
      }
      const row: { parent_run_id?: unknown } | undefined = db.prepare(
        "SELECT parent_run_id FROM flows_runs WHERE run_id=?"
      ).get(id)
      id = row?.parent_run_id === undefined || row.parent_run_id === null ? null : String(row.parent_run_id)
    }
    return { path: resolve(root) }
  } finally {
    db.close()
  }
}

/**
 * Undefined means a fork has not finished being linked to its workspace yet.
 * A location alone does not prove its control identity committed; execution
 * must also pass {@link canExecute}.
 * @since 1.0.0
 * @category getters
 */
export const workspaceFor = (root: string, runId: string): string | undefined => resolveWorkspace(root, runId)?.path

/**
 * Only the process bound to the run's durable workspace may claim it.
 * @since 1.0.0
 * @category guards
 */
export const canExecute = (root: string, workspace: string, runId: string): boolean => {
  const expected = resolveWorkspace(root, runId)
  if (expected === undefined || expected.path !== resolve(workspace)) return false
  const file = executionDatabasePath(root)
  const controlFile = databasePath(root)
  if (!existsSync(file) || !existsSync(controlFile)) return expected.boundRunId === undefined
  const engine = new DatabaseSync(file, { readOnly: true })
  try {
    const audits = hasTable(engine, "flows_time_travel_audits")
      ? engine.prepare(
        "SELECT id FROM flows_time_travel_audits WHERE run_id=? AND status IN ('in_progress','completed')"
      ).all(runId)
      : []
    if (audits.length === 0 && expected.boundRunId === undefined) return true
    const control = new DatabaseSync(controlFile, { readOnly: true })
    try {
      // Routes commit in engine.db before the control transaction commits.
      // A later failure can roll back that transaction while leaving the route.
      // Descendants inherit the bound fork's identity, not their own control row.
      if (
        expected.boundRunId !== undefined &&
        control.prepare("SELECT 1 FROM flows_runs WHERE run_id=?").get(expected.boundRunId) === undefined
      ) return false
      if (audits.length === 0) return true
      if (!hasTable(control, "smthrs_history_applied")) return false
      return audits.every((audit) =>
        control.prepare("SELECT 1 FROM smthrs_history_applied WHERE audit_id=?").get(String(audit.id)) !== undefined
      )
    } finally {
      control.close()
    }
  } finally {
    engine.close()
  }
}
