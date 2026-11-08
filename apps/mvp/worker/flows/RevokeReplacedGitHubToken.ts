import { Action, Flow, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import { GitHubRefused } from "../GitHubAuth.ts"
import type { Services } from "./RevokeGitHubToken.ts"
import * as SessionStore from "../SessionStore.ts"
import * as SessionEnds from "../SessionEnds.ts"

// Replacement cleanup owns only cleanup rows. It must never end or read a session.
const Result = Schema.Struct({ outcome: Schema.Literals(["revoked", "none"]) })
export class CleanupFailed extends Schema.TaggedError<CleanupFailed>()("GitHubTokenCleanupFailed", {
  reason: Schema.Literals(["database", "github_unavailable", "github_misconfigured", "unreadable"]),
}) {}
const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })
export const cleanups = Metric.counter("smithers_auth_token_cleanup", { incremental: true })
const record = (outcome: "revoked" | "retried" | "failed") => Effect.andThen(
  Metric.update(Metric.withAttributes(cleanups, { outcome }), 1),
  Effect.logWithLevel(outcome === "revoked" ? "Info" : "Warn")("auth.token_cleanup").pipe(Effect.annotateLogs({ outcome })),
)
export const executionId = (id: string) => `cleanup:${id}`
export const Revoke = Action.make("auth/RevokeReplacedToken", {
  payload: { cleanupId: Schema.String }, success: Result, error: CleanupFailed,
  capabilities: ["db:write:github_token_cleanups"], retryPolicy,
})
export const RevokeReplacedGitHubToken = Flow.make("auth/RevokeReplacedGitHubToken", {
  description: "Revoke a replaced GitHub token pair and retain its cleared cleanup receipt.",
  capabilities: ["db:write:github_token_cleanups"], modelInvocable: false,
  payload: { cleanupId: Schema.String }, success: Result, error: CleanupFailed,
  body: Node.capture({}, request => Revoke.call(request)),
})

/** GitHub's adapter treats 404 and 422 as successful revocations, including a replay after tombstone retention. */
export const revoke = (id: string, services: Services) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ sessionId: string; access: unknown; finished: boolean }>`
    SELECT session_id AS "sessionId", sealed_access AS access, finished_at IS NOT NULL AS finished
    FROM github_token_cleanups WHERE id = ${id}`
  if (row === undefined || row.finished) return { outcome: "none" as const }
  if (row.access !== null) {
    const sealed = yield* Schema.decodeUnknownEffect(SessionStore.Sealed)(row.access).pipe(
      Effect.mapError(() => new CleanupFailed({ reason: "unreadable" })),
    )
    const token = yield* services.keys.open(sealed, { id: row.sessionId, name: "github_access", version: 1 }).pipe(
      Effect.mapError(() => new CleanupFailed({ reason: "unreadable" })),
    )
    yield* services.github.revoke(token)
  }
  yield* sql`UPDATE github_token_cleanups SET sealed_access = NULL, sealed_refresh = NULL, finished_at = clock_timestamp()
    WHERE id = ${id} AND finished_at IS NULL`
  yield* record("revoked")
  return { outcome: "revoked" as const }
}).pipe(Effect.withSpan("auth.token_cleanup"))

/** A durable row covers a refused launch or a crash between commit and launch. */
export const start = (id: string) => Effect.gen(function* () {
  const starter = yield* Effect.serviceOption(Flows.FlowStarter)
  if (Option.isNone(starter)) { yield* record("retried"); return }
  yield* starter.value.start(RevokeReplacedGitHubToken, { executionId: executionId(id), payload: { cleanupId: id } }).pipe(
    Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.void),
    Effect.catchCause(() => record("retried")),
  )
})

/** Pending rows are durable requests. Finished rows keep their digest for thirty days after completion. */
export const sweep = () => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* SessionEnds.sweep()
  yield* sql`DELETE FROM github_token_cleanups WHERE finished_at < now() - interval '30 days'`
  const rows = yield* sql<{ id: string }>`SELECT id FROM github_token_cleanups
    WHERE finished_at IS NULL AND created_at < now() - interval '5 minutes' ORDER BY created_at, id`
  return rows.map(row => row.id)
})
const SweepResult = Schema.Struct({ pending: Schema.Number })
export const Sweep = Action.make("auth/SweepReplacedTokens", {
  payload: { from: Schema.Number, until: Schema.Number }, success: SweepResult, error: CleanupFailed,
  capabilities: ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts", "db:write:person_role_receipts"], retryPolicy,
})
export const SweepReplacedGitHubTokens = Flow.make("auth/SweepReplacedGitHubTokens", {
  description: "Restart pending GitHub token cleanups and expire thirty-day cleanup receipts.",
  capabilities: ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts", "db:write:person_role_receipts"], modelInvocable: false,
  payload: { from: Schema.Number, until: Schema.Number }, success: SweepResult, error: CleanupFailed,
  body: Node.capture({}, window => Sweep.call(window)),
})
const failed = (error: unknown) => error instanceof CleanupFailed ? error : new CleanupFailed({
  reason: error instanceof GitHubRefused ? error.reason === "misconfigured" ? "github_misconfigured" : "github_unavailable" : "database",
})
const observed = <A, E, R>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  effect.pipe(Effect.provide(database), Effect.tapError(error => Effect.andThen(record("failed"),
    Effect.logWarning("auth.token_cleanup.failure").pipe(Effect.annotateLogs({ errorCode: codeOf(error) })))), Effect.mapError(failed))
const maintenanceCapabilities = ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts", "db:write:person_role_receipts"]
const maintenanceError = Schema.Union([CleanupFailed, Sleep.SleepRequestInvalid])

/** Each round uses chat/Expire's durable sleep and handoff, so an idle deployment keeps its own alarm. */
export const MaintainSessions: Flow.Flow<
  "auth/MaintainSessions", Schema.Struct<{}>, typeof Schema.Void, typeof maintenanceError,
  Action.Requirement<"auth/SweepReplacedTokens">
> = Flow.make("auth/MaintainSessions", {
  description: "Retain session ends and recover pending token cleanup every five minutes.",
  capabilities: maintenanceCapabilities, modelInvocable: false,
  payload: {}, success: Schema.Void, error: maintenanceError,
  body: Node.capture({}, () => Sweep.call({ from: 0, until: 0 }).pipe(
    Node.andThen(Sleep.action.call({ millis: 300_000 })),
    Node.andThen(MaintainSessions.to({})),
  )),
})

export const maintenance = Metric.counter("smithers_auth_session_maintenance", { incremental: true })
const maintenanceRecord = (outcome: "admitted" | "unavailable" | "swept") => Effect.andThen(
  Metric.update(Metric.withAttributes(maintenance, { outcome }), 1),
  Effect.logWithLevel(outcome === "unavailable" ? "Warn" : "Info")("auth.session_maintenance").pipe(Effect.annotateLogs({ outcome })),
)

/** One bounded seed per isolate; failure never denies authentication. The durable alarm owns subsequent rounds. */
export const ensure = Effect.flatMap(Flows.FlowStarter, starter => starter.start(MaintainSessions, {
  executionId: "auth:session-maintenance:v1", payload: {},
})).pipe(
  Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.void),
  Effect.timeout("1 second"),
  Effect.tap(() => maintenanceRecord("admitted")),
  Effect.tapCause(() => maintenanceRecord("unavailable")),
  Effect.withSpan("auth.session_maintenance.admit"),
)

export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, services: Services) => {
  const sweeping = Sweep.toLayer(() => observed(Effect.gen(function* () {
    const ids = yield* sweep()
    yield* Effect.forEach(ids, start, { concurrency: 4, discard: true })
    yield* maintenanceRecord("swept")
    return { pending: ids.length }
  }), database))
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(RevokeReplacedGitHubToken, Revoke.toLayer(({ cleanupId }) => observed(revoke(cleanupId, services), database))),
    Interpreter.layerWithImplementations(SweepReplacedGitHubTokens, sweeping),
    Interpreter.layerWithImplementations(MaintainSessions, sweeping),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}

