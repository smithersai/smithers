/*
 * The wire shape of GET /api/repos/{owner}/{repo}/bookmarks (multi
 * src/smithersCloud/bookmarks.ts): a cursor envelope `{ items, next_cursor }`
 * whose rows carry name, target_change_id, target_commit_id and
 * is_tracking_remote. An empty next_cursor is the last page. Recorded once
 * here so every seam that reads the route (BookmarksSeam, RepositoriesSeam)
 * is tested against the same envelope.
 */
export const BOOKMARK_WIRE = {
  /** One bookmark row; plue answers an empty target_commit_id when the bookmark has no resolved git commit. */
  row: (name: string, changeId: string, commitId = "") => ({
    name,
    target_change_id: changeId,
    target_commit_id: commitId,
    is_tracking_remote: true
  }),
  /** One page of the envelope; `nextCursor` "" closes the list. */
  page: (items: ReadonlyArray<unknown>, nextCursor = "") => ({ items, next_cursor: nextCursor })
}
