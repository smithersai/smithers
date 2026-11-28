import type { ProjectSummary } from "../../../src/features/projects/schema"

export function projectsInAttentionOrder(projects: readonly string[], summaries: ReadonlyMap<string, ProjectSummary>): string[] {
  return [...projects].sort((left, right) => {
    const leftWaiting = summaries.get(left)?.needsAttention ?? null
    const rightWaiting = summaries.get(right)?.needsAttention ?? null
    if (leftWaiting === null) return rightWaiting === null ? left.localeCompare(right) : 1
    if (rightWaiting === null) return -1
    return rightWaiting - leftWaiting || left.localeCompare(right)
  })
}
