// The fleet's contract between the browser and ChatApi (decision 0136, docs/features/fleet.md): the shape routes, the
// columns each audience syncs, and the thresholds the view reads. Nothing here imports a library, so every side can.

/** `GET ?repo=<owner>/<name>`: Electric's `agent_runs` of one repository, for its Members and up. */
export const AGENT_RUNS_SHAPE_ROUTE = "/api/shapes/agent-runs"

/** `GET ?repo=<owner>/<name>`: Electric's `runners` of one repository, for its Maintainers and up. */
export const MACHINES_SHAPE_ROUTE = "/api/shapes/machines"

/** The columns of `agent_runs` a repository's Members sync: never its account label or the probe's own bookkeeping. */
export const AGENT_RUN_COLUMNS = [
  "key",
  "repo_id",
  "agent",
  "generation",
  "run_id",
  "number",
  "title",
  "runner",
  "state",
  "reason",
  "queued_at",
  "claimed_at",
  "first_event_at",
  "last_event_at",
  "activity_at",
  "ended_at",
  "context_tokens",
  "cost_usd",
  "transcript_bytes",
] as const

/** A Maintainer's or Admin's columns: the account label too (FINAL.md §4.1). */
export const AGENT_RUN_MAINTAINER_COLUMNS = [...AGENT_RUN_COLUMNS, "account_label"] as const

/** The columns of `runners` a repository's Maintainers sync: never its token's digest or who added it. */
export const MACHINE_COLUMNS = [
  "id",
  "repo_id",
  "name",
  "labels",
  "capacity",
  "seen_at",
  "removed_at",
  "version",
  "load1",
  "disk_free_gb",
] as const

/** How long after its last request a runner reads Offline (worker/runners/Fleet.ts `UNREACHABLE_SECONDS`). */
export const UNREACHABLE_SECONDS = 45

/** A run's states, as `agent_runs.state` holds them. */
export const RUN_STATES = ["queued", "working", "stalled", "stopping", "stopped", "failed", "done", "retried"] as const
export type RunState = (typeof RUN_STATES)[number]

/** A run's state in product words (FINAL.md §4.1): a queued run is Waiting for a runner. */
export const RUN_WORDS: Readonly<Record<RunState, string>> = {
  queued: "Waiting",
  working: "Working",
  stalled: "Stalled",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  done: "Done",
  retried: "Retried",
}

/** Whether a run still holds its runner's slot or waits for one. */
export const isLive = (state: RunState): boolean =>
  state === "queued" || state === "working" || state === "stalled" || state === "stopping"
