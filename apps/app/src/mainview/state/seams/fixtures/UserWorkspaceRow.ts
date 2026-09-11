/*
 * plue's UserWorkspaceRow, one row of GET /api/user/workspaces
 * (internal/services/workspace.go): the per-user switcher row — workspace_id,
 * repository_owner, repository_name, workspace_title, state — which carries
 * no bookmark, stage, or suspension time. Recorded once here so every seam
 * that reads the route (WorkspaceSeam, RepositoriesSeam) is tested against
 * the same wire shape.
 */
export const USER_WORKSPACE_ROW = {
  workspace_id: "ws-1",
  repository_id: 7,
  repository_owner: "will",
  repository_name: "smithers",
  workspace_title: "review",
  state: "running",
  last_accessed_at: null,
  last_activity_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z",
  sort_timestamp: "2026-09-01T00:00:00Z"
}
