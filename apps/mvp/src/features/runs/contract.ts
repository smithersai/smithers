// Runs' contract (decision 0014 §3 and §5, docs/features/runs.md): the one home of the values the tab, the engine
// worker and the tests share. Nothing here imports a library, so every side can.

/** The route of every run this person may read. */
export const RUNS_PATH = "/app/runs"

/** The route of one run's page. */
export const runPath = (runId: string): string => `${RUNS_PATH}/${encodeURIComponent(runId)}`

/**
 * `GET <route>/<runId>?afterSeq=<n>&limit=<n>`: a run Smithers runs on Cloudflare, as the engine's `RunInspection` reads
 * it, for a person who may read the TODO it works on (ruling TODO-3).
 */
export const REMOTE_RUNS_ROUTE = "/api/remote-runs"

/** That route for one run. */
export const remoteRunRoute = (runId: string): string => `${REMOTE_RUNS_ROUTE}/${encodeURIComponent(runId)}`

/**
 * `POST <route>/<runId>/steers { id, body }`: a person's message to a TODO's running agent (ruling TODO-3), admitted to
 * the run's durable notification queue; the agent reads it at its next turn boundary.
 */
export const steersRoute = (runId: string): string => `${remoteRunRoute(runId)}/steers`

/**
 * `GET <route>?limit=<n>`: the runs on Cloudflare this person may read, newest first (docs/features/runs.md#runs-on-cloudflare):
 * TODO runs and repositories' runs for a Member, and the deployment's own system flows for an Admin.
 */
export const CLOUD_RUNS_ROUTE = "/api/cloud-runs"

/** The most runs on Cloudflare one list read answers. */
export const CLOUD_RUNS_LIMIT = 50

/** `POST <route>/<runId>/stop`: Stop a repository's run on Cloudflare (docs/features/actions.md#acts). */
export const stopRoute = (runId: string): string => `${remoteRunRoute(runId)}/stop`

/**
 * Why the stop route refused, as `{ code }`: `authentication` (401), `forbidden` (403: not a Member), `not_found` (404:
 * no repository's run has that id) and `unavailable` (503).
 */
export const STOP_REFUSALS = ["authentication", "forbidden", "not_found", "unavailable"] as const
export type StopRefusal = (typeof STOP_REFUSALS)[number]

/** The step whose agent a steer reaches: the `todo` run's agent (worker/flows/TodoAgent.ts `Implement`). */
export const STEERED_ACTION = "todo/Implement"

/**
 * Whether a TODO's run still has an agent to steer: neither the run nor its agent's step has ended. The steer route
 * admits a message only then, and the run page offers the composer only then.
 */
export const steerable = (
  run: { readonly status: string },
  steps: ReadonlyArray<{ readonly action: string | null; readonly status: string }>,
): boolean =>
  !settled(run.status) &&
  !steps.some((step) => step.action === STEERED_ACTION && step.status !== "running" && step.status !== "waiting")

/** The longest steer, in characters. */
export const MAX_STEER_CHARS = 4_000

/**
 * The most a steer may take as JSON, in UTF-8 bytes: its admission record, which the run page reads its words back
 * from, stays inside the engine's 16 KiB cut of a value however many characters escape.
 */
export const MAX_STEER_JSON_BYTES = 12 * 1024

/** The most bytes the steer route reads of a body. */
export const MAX_STEER_BODY_BYTES = 32 * 1024

/**
 * Why the steer route refused a message, as `{ code }`: `invalid` (400), `authentication` (401), `forbidden` (403: not
 * a Member), `not_found` (404: no TODO's run has that id), `not_working` (409: the run or its agent has ended, or the
 * engine hasn't begun it), `conflict` (409: the id was sent before with another message), `too_large` (413), `full`
 * (429: the run holds 128 undelivered messages) and `unavailable` (503).
 */
export const STEER_REFUSALS = [
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "not_working",
  "conflict",
  "too_large",
  "full",
  "unavailable",
] as const
export type SteerRefusal = (typeof STEER_REFUSALS)[number]

/**
 * The namespace a `run/steer` run's message id is derived in (RFC 9562 version 5): its execution id's UUID, so a step
 * run again names the same message, and the route takes it once.
 */
export const STEER_ID_NAMESPACE = "6f1d2b8e-4c57-4a93-b0e6-2d9c7f3a1e58"

/** The engine channel a steer step asks the tab that started it on: `<engine name>/runs`. */
export const runsChannel = (engineName: string): string => `${engineName}/runs`

/** How long a steer step waits for the tab that asked to queue its message. */
export const STEER_QUEUE_WITHIN = "10 seconds"

/** Refusals a send never retries: the message is Not sent, with why. */
export const STEER_FINAL = ["invalid", "authentication", "forbidden", "not_found", "not_working", "conflict", "too_large"] as const

/** `GET ...?run=<runId>`: Electric's row of that run in the engine's change feed, which moves with the run. */
export const REMOTE_RUN_SHAPE_ROUTE = "/api/shapes/remote-runs"

/**
 * The engine's change feed (`@smthrs/run-store` migration `0003_execution_revisions`): one row per run, whose
 * `revision` moves on every change of the run's row (a step's attempt starting or ending, a wait, its settling).
 */
export const RUN_CHANGES_TABLE = "flows_run_changes"

/** The change feed's columns a device syncs: the run and its revision. */
export const RUN_CHANGE_COLUMNS = ["run_id", "revision"] as const

/** A TODO's run's execution id: `todo:<attempt id>` (src/features/pulls/contract.ts `todoExecutionId`). */
const TODO_RUN = /^todo:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether this device reads `runId` from Cloudflare, not its own engine: a TODO's run. */
export const isRemoteRun = (runId: string): boolean => TODO_RUN.test(runId)

/**
 * Why the remote runs route refused a read, as `{ code }`: `invalid` (400), `authentication` (401), `forbidden` (403:
 * not a Member), `not_found` (404: no TODO's run has that id), `not_started` (404: its attempt is recorded and the
 * engine hasn't begun it yet) and `unavailable` (503).
 */
export const REMOTE_READ_REFUSALS = [
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "not_started",
  "unavailable",
] as const
export type RemoteReadRefusal = (typeof REMOTE_READ_REFUSALS)[number]

/** How many runs the list shows: the newest. */
export const RUN_LIST_LIMIT = 50

/** Maximum durable identities examined before Retry refuses this attempt. */
export const RETRY_ID_SEARCH_LIMIT = 1_024

/** How many journal events one read of a run's page takes: the engine's page bound. */
export const JOURNAL_PAGE = 500

/**
 * Whether a run of `flow` is work a person lists: an act on a run (`run/*`) isn't, nor the host's own work on the
 * device, such as preparing its store for a new build (`device/prepare`, decision 0021).
 */
export const listed = (flow: string): boolean => !flow.startsWith("run/") && !flow.startsWith("device/")

/** The engine's settled states: a run in one never changes again. */
export const SETTLED = ["completed", "failed", "cancelled"] as const

/** Whether a run in `status` has settled. */
export const settled = (status: string): boolean => (SETTLED as ReadonlyArray<string>).includes(status)

/**
 * Why an act on a run was refused:
 * - `not_found`: this engine holds no such run;
 * - `stale`: the run moved since the page read it (its journal's last sequence differs), so the page shows it again;
 * - `settled`: it has settled, so there is nothing to stop or resume;
 * - `not_settled`: it hasn't settled, so there is nothing to retry yet;
 * - `not_retryable`: its flow is never retried with its own payload;
 * - `not_here`: this engine doesn't run its flow, or can't retry it from a step;
 * - `step_not_run`: Retry from here named a step the run never ran, or one it never settled;
 * - `forbidden`: Cloudflare refused it: only a Member stops a repository's run.
 *
 * A store that can't be read or can't record the act fails the act's step instead; the page says the engine couldn't
 * be reached (`unavailable` in `REFUSAL_WORDS`).
 */
export const ACT_REFUSALS = [
  "not_found",
  "stale",
  "settled",
  "not_settled",
  "not_retryable",
  "not_here",
  "step_not_run",
  "forbidden",
] as const

/** The new run a retry starts for the act `actId`: one per act, so a repeated Retry starts one run. */
export const retriedRunId = (actId: string): string => `${actId}/run`

/** The act a person's Retry dispatches as: `retry:<runId>:<n>`, the n-th retry of that run. */
export const retryActId = (runId: string, n: number): string => `retry:${runId}:${n}`

/**
 * What runs record (docs/observability.md#runs): reads of a run in the tab and in the leader, and acts on runs. Ids,
 * counts, codes and sizes only: never a value of a run.
 */
export const RUNS_TELEMETRY = {
  records: [
    "run.route.stage",
    "smithers_run_route_ms",
    "run.inspect",
    "run.act",
    "run.read",
    "run.retry.reserve",
    "run.retry.revision",
    "runs.repo_runs.load",
    "run.steer.send",
    "smithers_run_acts",
    "smithers_run_reads",
    "smithers_run_steer_sends",
    "smithers_run_follow_changes",
  ],
  fields: [
    "routeAttempt",
    "stage",
    "phase",
    "elapsedMs",
    "rows",
    "runId",
    "act",
    "host",
    "outcome",
    "events",
    "bytes",
    "clipped",
    "durationMs",
    "smithers.run.host",
    "steerId",
    "via",
    "status",
    "code",
    "errorCode",
  ],
} as const

/** The run page's buttons and lines (MINIMAL TEXT: a word each). */
export const STOP = "Stop"
export const RETRY = "Retry"
export const RETRY_LATEST = "Retry latest"
/** The inspector's act on a step: a new run that replays the steps before it and runs from it (ruling FLOW-11). */
export const RETRY_FROM = "Retry from here"
export const RESUME = "Resume"
export const ANSWER = "Answer"
export const OPEN = "Open"
export const THIS_DEVICE = "This device"
export const NO_RUNS = "No runs yet"
export const COULDNT_READ = "Couldn't read this run"
export const ON_ANOTHER_DEVICE = "On another device"
export const NOT_FOUND = "Not found"
export const NOT_STARTED = "Not started"
/** Where a run Smithers runs on Cloudflare runs, as its header says. */
export const CLOUD = "Cloud"

/** The steer composer's label and button, and a steer's states on the run page. */
export const STEER = "Steer"
export const STEER_LABEL = "Steer the agent"
export const STEER_SENDING = "Sending"
export const STEER_SENT = "Sent"
export const STEER_DELIVERED = "Delivered"
export const STEER_NOT_DELIVERED = "Not delivered"
export const STEER_NOT_SENT = "Not sent"
/** Selects the agent's step after a delivered steer: its response. */
export const NEXT_STEP = "Next step"

/** Why a steer is Not sent, in a few words, by the route's code. */
export const STEER_REFUSAL_WORDS: Readonly<Record<SteerRefusal, string>> = {
  invalid: "Can't send this",
  authentication: "Sign in",
  forbidden: "Members only",
  not_found: "No such run",
  not_working: "The agent finished",
  conflict: "Sent before",
  too_large: "Too long",
  full: "Too many waiting",
  unavailable: "Couldn't reach Smithers",
}

/** What a refused act reads as on the run page, by its code. */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  stale: "It moved. Look again.",
  settled: "It already ended.",
  not_settled: "It hasn't ended.",
  not_retryable: "This run can't be retried.",
  not_here: "This device can't run it.",
  step_not_run: "This step didn't run.",
  not_found: "Not on this device.",
  forbidden: "Members only.",
  invalid: "Invalid action.",
  refused: "Action refused.",
  interrupted: "Action interrupted.",
  defect: "Action failed.",
  unavailable: "Couldn't reach the engine.",
}
