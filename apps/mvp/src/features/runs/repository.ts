import type { CloudRun, RunPage } from "./schema"

/**
 * The repository a run belongs to, `owner/name`, when this tab can tell: its own Cloudflare row's, else that of the run
 * it descends from (its parent, up the inspection's chain). `null` for a person's own run. Its views gate on it
 * (`repoVisibility`), so a refused repository's run shows nothing on the global Runs pages either.
 */
export const runRepository = (runId: string, page: RunPage | undefined, cloud: ReadonlyArray<CloudRun>): string | null => {
  const repoOf = (id: string | null | undefined) => (id == null ? null : cloud.find((run) => run.runId === id)?.repo ?? null)
  const own = repoOf(runId)
  if (own !== null) return own
  const inspection = page?.state === "read" ? page.inspection as { readonly run?: { readonly parentRunId?: string | null } } : undefined
  return repoOf(inspection?.run?.parentRunId)
}
