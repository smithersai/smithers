// A repository's runs (docs/features/actions.md, work notes ci-parity-run-view and ci-parity-manual-run): the one home
// of the values ChatApi's routes, the browser and the tests share. Nothing here imports a library, so every side can.

/** `GET ...?repo=<owner>/<name>`: Electric's shape of a repository's runs, the `runs` rows with an execution. */
export const ACTIONS_SHAPE_ROUTE = "/api/shapes/actions"

/** The `runs` columns the list reads: never who launched a run. */
export const ACTION_COLUMNS = [
  "id",
  "repo_id",
  "execution",
  "flow",
  "status",
  "sha",
  "ref",
  "event",
  "created_at",
  "updated_at",
] as const

/** What started a repository's run: a push, a pull request, or a person by hand. */
export const RUN_EVENTS = ["push", "pull_request", "manual"] as const
export type RunEvent = (typeof RUN_EVENTS)[number]

/** A repository run's states as its row holds them: settled from the engine's status when the run settles. */
export const ACTION_STATES = ["working", "done", "failed", "stopped"] as const
export type ActionState = (typeof ACTION_STATES)[number]

/** The engine's settled status, as a repository run's row holds it. */
export const settledState = (status: "completed" | "failed" | "cancelled"): ActionState =>
  status === "completed" ? "done" : status === "cancelled" ? "stopped" : "failed"

/** The namespace a repository run's row id is derived in (RFC 9562 version 5): from its execution id. */
export const REPO_RUN_NAMESPACE = "8b7c4e2a-1f63-4d09-9a5e-3c6f0d2b7e41"

/** How many runs the list shows: the newest. */
export const ACTIONS_LIMIT = 100

/** How deep the route walks a run's parents to find the repository run that started it. */
export const LINEAGE_DEPTH = 16

/** `/$owner/$repo/runs`: the repository's runs. */
export const actionsPath = (owner: string, name: string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/runs`

/** `/$owner/$repo/actions/runs/$runId`: one of its runs, read from Cloudflare. */
export const actionRunPath = (owner: string, name: string, runId: string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${encodeURIComponent(runId)}`
