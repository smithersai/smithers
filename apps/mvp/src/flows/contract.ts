// Flows' contract between the tab, its engine worker and ChatApi's telemetry relay (docs/features/flows.md): the one
// home of the values they share. Nothing here imports a library, so every side can.
import { RUNS_ROUTE } from "../features/status/contract"

/** The engine's name in every tab and its worker: its Web Lock, its channel and its OPFS directory. */
export const ENGINE_NAME = "smithers"

/**
 * What starts a dispatch: a button, a slash command, a view, the composer, the agent's cell, sync, when a row another
 * device wrote asks this device to act on a run it holds (an answer to deliver, decision 0015), or a key the person
 * pressed in host UI (the keymap and the action strip, decision 0017).
 */
export const DOORS = ["button", "slash", "view", "composer", "agent", "sync", "key"] as const

/**
 * The person's own doors (decision 0017 slice 0): a press, a typed command, a question sent, a key in host UI. A root
 * run of a person's flow started through one of them runs with the person's session; every other run gets a run
 * credential (docs/features/sign-in.md#run-credentials).
 */
export const PERSON_DOORS: ReadonlyArray<(typeof DOORS)[number]> = ["button", "slash", "composer", "key"]

/** How long a run credential lasts (worker/RunCredentials.ts); the engine mints a fresh one a minute before then. */
export const CREDENTIAL_TTL_MS = 15 * 60 * 1000

/** `POST /api/runs/<run>/credential`: run `run`'s credential, its execution id percent-encoded. */
export const credentialRoute = (run: string): string => `${RUNS_ROUTE}/${encodeURIComponent(run)}/credential`

/** The engine's channel to the tab that started a run: which door it came through (src/flows/credentials.ts). */
export const doorChannel = (name: string): string => `${name}/door`

/**
 * What flows record in the browser (docs/observability.md#browser), by name, and the attributes they carry: dispatch in
 * the tab; the tab's side of the engine and the leader in the engine worker (`@smthrs/platform-browser`); and the
 * durable engine every client flow runs on (`@smthrs/flows`). The engine's storage spans (its statements, runs,
 * attempts and journal) are left out: hundreds per run, they would overflow the relay's limits, and the engine
 * worker's exporter sends only spans named here. ChatApi's relay keeps exactly what src/telemetry.ts merges from every
 * feature; none of these fields carries a flow's input.
 */
export const FLOWS_TELEMETRY = {
  records: [
    "flow.dispatch",
    "smithers_flow_dispatches",
    // Whose data the device holds, checked before the engine starts (src/device/identity.ts).
    "auth.device_identity",
    "smithers_device_identity_checks",
    // Run credentials on the device (src/flows/credentials.ts).
    "auth.run_credential",
    "smithers_run_credential_mints",
    // The tab's side of the engine (@smthrs/platform-browser BrowserEngine, StoragePersistence).
    "browser.engine.storage",
    "browser.engine.unavailable",
    "browser.storage.persist",
    "smithers_browser_engine_requests",
    "smithers_browser_engine_storage",
    "smithers_browser_engine_unavailable",
    // The leader, in the engine worker (@smthrs/platform-browser BrowserRuntime).
    "browser.runtime.elect",
    "browser.runtime.leader",
    "browser.runtime.wake",
    "browser.runtime.request",
    "browser.runtime.statement",
    "browser.runtime.lost",
    "browser.runtime.stopped",
    "smithers_browser_runtime_leaderships",
    "smithers_browser_runtime_wakes",
    "smithers_browser_runtime_requests",
    "smithers_browser_runtime_statements",
    // The durable engine (@smthrs/flows): each flow run and each step, and its warnings and counts.
    "flows.runtime.phase",
    "FlowEngine.execute",
    "Action.execute",
    // A run's admission and its claim, with when each happened, and how long recovering a registration took.
    "flow.run.created",
    "flow.run.claimed",
    "engine-store.registration.recovered",
    "action attempt interrupted: the engine store is unavailable",
    "run lease lapsed; interrupting owned work",
    "run heartbeat write failed",
    "run heartbeat receipt failed",
    "A step log record could not be journaled",
    "flows_engine_heartbeat_receipts",
    "flows_engine_replay_seeds",
    "flows_engine_dispatches",
    "flows_engine_dispatch_duration",
    "flows_engine_claims",
    "flows_engine_storage_unavailable",
    "flows_engine_boundary_settlements",
    "flows_engine_step_cache_decisions",
    "flows_engine_scheduler_admissions",
    "flows_engine_scheduler_dispatch_duration",
    "flows_engine_scheduler_nodes",
    "flows_engine_step_logs",
    "flows_run_claims",
    "flows_run_transitions",
    "flows_run_heartbeats",
    "flows_run_throughput",
    "flows_journal_writes",
    "flows_journal_lost",
    "flows_db_writer_lock_wait",
    "flows_db_writer_lock_timeouts",
    "flows_db_connection_wait",
    "flows_db_login_failures",
    "postgres.connection.waiting",
    "postgres.login.failed",
    "flows_db_write_retries",
    "flows_step_cache_lookups",
    "flows_step_cache_puts",
    // Usage: which flows run and how (@smthrs/flow RunMetrics, recorded by the engine and the agent's model steps).
    "flow.run.created",
    "flow.run.claimed",
    "flow.run.started",
    "flow.run.settled",
    "flow.model.call",
    "flows_runs_started",
    "flows_runs_settled",
    "flows_run_duration_ms",
    "flows_run_first_step_ms",
    "flows_steps",
    "flows_step_retries",
    "flows_waits",
    "flows_wait_ms",
    "flows_model_calls",
    "flows_model_tokens",
  ],
  fields: [
    "flow",
    "door",
    "executionId",
    "outcome",
    "refusal",
    "durationMs",
    "phase",
    "smithers.flow.name",
    "smithers.flow.door",
    "smithers.flow.outcome",
    "request",
    "error.type",
    "flows",
    "smithers.execution.id",
    "createdAtMs",
    "claimedAtMs",
    "smithers.flow",
    "createdAtMs",
    "claimedAtMs",
    "smithers.request",
    "smithers.request.outcome",
    "smithers.wake",
    "runId",
    "action",
    "stepKey",
    "stepKeyDigest",
    "attempt",
    "tier",
    "error",
    "code",
    "unconfirmedMs",
    "op",
    "to",
    "channel",
    "receipt",
    "operation",
    "time_unit",
    "effect.fiber.interrupted",
    "act",
    "principal",
    "depth",
    // RunMetrics' labels: closed sets, a capped flow tag and model id, token counts. Never a payload or who.
    "actor",
    "placement",
    "kind",
    "model",
    "direction",
    "inputTokens",
    "outputTokens",
  ],
} as const
