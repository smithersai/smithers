import { db } from "@/db/client"

export function deleteAllApprovals() {
  const result = db.query(`DELETE FROM approvals`).run()
  return result.changes
}

export function deleteAllRunEvents() {
  const result = db.query(`DELETE FROM run_events`).run()
  return result.changes
}

export function deleteAllWorkspaces() {
  const result = db.query(`DELETE FROM workspaces`).run()
  return result.changes
}
