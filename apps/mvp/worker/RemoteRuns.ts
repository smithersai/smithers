import { ShapeProxy } from "@smthrs/effect-electric"
import type { Flow } from "@smthrs/flow"
import { Database, EngineStore, Journal } from "@smthrs/flows"
import { Notification, NotificationQueue, SteerPayload } from "@smthrs/notifications"
import { Cause, Clock, Data, Effect, Layer, Metric, Option, Predicate, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../src/features/chat/contract.ts"
import {
  CLOUD_RUNS_ROUTE,
  isRemoteRun,
  JOURNAL_PAGE,
  MAX_STEER_BODY_BYTES,
  MAX_STEER_CHARS,
  MAX_STEER_JSON_BYTES,
  REMOTE_RUN_SHAPE_ROUTE,
  type RemoteReadRefusal,
  REMOTE_RUNS_ROUTE,
  RUN_CHANGE_COLUMNS,
  RUN_CHANGES_TABLE,
  settled,
  steerable,
  type SteerRefusal,
  type StopRefusal,
} from "../src/features/runs/contract.ts"
import { type Actor, Sessions } from "./Actor.ts"
import { readBounded } from "./Body.ts"
import * as CloudRuns from "./CloudRuns.ts"
import { codeOf } from "./ErrorCode.ts"
import * as ShapeAccess from "./ShapeAccess.ts"
import * as RepoRuns from "./RepoRuns.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { repositoryOf } from "./github/Config.ts"
import { mayRead } from "./stack/Access.ts"

// Runs Smithers runs on Cloudflare, read from the browser (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare), and
// a repository's runs (docs/features/actions.md), read and stopped with a role on their recorded repository.
// A TODO's `todo` run lives in the engine's Postgres schema, not on any device, so a person watches it through two
// routes, both for a signed-in Member or above, as the TODO itself, and only for a run some TODO's attempt started:
//
// - `GET /api/remote-runs/<runId>?afterSeq=<n>&limit=<n>`: the run as the engine's own `RunInspection`
//   (`@smthrs/engine-store`) reads it, the same read a device's engine answers its run page with. Every value is
//   redacted, rendered through its flow's or step's schema (`<redacted>`, `<withheld>`), reduced to a code when it is
//   a failure, and cut to 16 KiB before it leaves the engine. Never cached.
// - `GET /api/shapes/remote-runs?run=<runId>`: Electric's row of that run in the engine's change feed
//   (`flows_run_changes`: the run id and its revision, which moves whenever the run's row does), so the page reads the
//   run again as it works, with no polling.
//
// Each read is a span and a log line `run.inspect` with the host (`remote`), its outcome, how many events and bytes it
// released, how many values were cut and how long it took, and one count by outcome: never a value of a run.
//
// A Member steers the run's agent through a third route (docs/features/runs.md#steering):
//
// - `POST /api/remote-runs/<runId>/steers { id, body }`: the message is admitted to the run's own durable notification
//   queue (`@smthrs/notifications`) in the engine's schema, keyed by `id`, the outbox's id for it, as a person's steer
//   (`Notification.humanSteer`). The run's agent drains that queue at each turn boundary
//   (worker/flows/TodoAgent.ts `registration`), so the message reaches the agent's next turn; the delivery is the
//   queue's own journal record, which the run page reads. Only while the run and its agent haven't ended.
//
// Each steer is a span and a log line `run.steer` with its id, who sent it (`person` or `agent`), its outcome and size,
// and one count by outcome: never the message.

/** Remote run reads, by `outcome`: `read`, or the refusal's code. */
export const reads = Metric.counter("smithers_remote_run_reads", {
  description: "GET /api/remote-runs/<runId> requests, by outcome",
  incremental: true,
})

/** Steers, by `outcome`: `taken`, `existing`, or the refusal's code. */
export const steers = Metric.counter("smithers_run_steers", {
  description: "POST /api/remote-runs/<runId>/steers requests, by outcome",
  incremental: true,
})

/** Stops, by `outcome`: `requested`, `settled`, or the refusal's code. */
export const stops = Metric.counter("smithers_run_stops", {
  description: "POST /api/remote-runs/<runId>/stop requests, by outcome",
  incremental: true,
})

/** Change shape requests, by `status` and `live`. */
export const shapeRequests = Metric.counter("smithers_remote_run_shape_requests", {
  description: "GET /api/shapes/remote-runs requests, by status and live",
  incremental: true,
})

/** Where the runs are: the engine's own database, its schema (the shape's table lives there), and its flows. */
export interface Engine<E, R, RS = never> {
  /** A reader of the engine's schema (worker/ExecutionHost.ts `readDatabase`). */
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  /**
   * A writer of the engine's schema (worker/ExecutionHost.ts `database`), for admitting a steer to a run's queue. It
   * takes the engine's writer lock, so it and the run's own engine never write the run's journal at once.
   */
  readonly writer: Layer.Layer<SqlClient.SqlClient, E, R>
  /** The engine's Postgres schema, `smithers_flows` when deployed (worker/ExecutionHost.ts `ENGINE_SCHEMA`). */
  readonly schema: string
  /** The flows whose runs render through their own schemas: the remote flows a TODO and a repository start. */
  readonly flows: ReadonlyArray<Flow.Any>
  /**
   * Stops a repository's run on the Durable Object that holds it (`ExecutionObject.make`'s `cancel`): a durable
   * tombstone, then the engine's cancellation of the run and every run it started. A run its object hasn't begun is
   * cancelled before it starts.
   */
  readonly stop: (runId: string) => Effect.Effect<void, unknown, RS>
}

/** A run route's run, from `/api/remote-runs/<runId>`: the id, as the path names it; none for any other path. */
export const parseRunPath = (path: string): string | undefined => {
  if (!path.startsWith(`${REMOTE_RUNS_ROUTE}/`)) return undefined
  const rest = path.slice(REMOTE_RUNS_ROUTE.length + 1)
  if (rest === "" || rest.includes("/")) return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    return undefined
  }
}

/** A steer route's run, from `/api/remote-runs/<runId>/steers`: the id, as the path names it; none for any other path. */
export const parseSteerPath = (path: string): string | undefined =>
  path.endsWith("/steers") ? parseRunPath(path.slice(0, -"/steers".length)) : undefined

/** A stop route's run, from `/api/remote-runs/<runId>/stop`: the id, as the path names it; none for any other path. */
export const parseStopPath = (path: string): string | undefined =>
  path.endsWith("/stop") ? parseRunPath(path.slice(0, -"/stop".length)) : undefined

/** Whether a path is one of the remote runs' routes, the list of runs on Cloudflare included. */
export const handles = (path: string): boolean =>
  path === REMOTE_RUN_SHAPE_ROUTE || path === CLOUD_RUNS_ROUTE || parseRunPath(path) !== undefined ||
  parseSteerPath(path) !== undefined || parseStopPath(path) !== undefined

/** A steer's body: the outbox's id for it, and the message. */
const SteerBody = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)),
  body: Schema.String,
})
const decodeSteerBody = Schema.decodeUnknownOption(Schema.fromJsonString(SteerBody))

/** Who a steer comes from, as the run's model reads it: the person, and whether an agent sent it for them. */
const steererOf = (actor: Actor) => ({
  actor: `person:${actor.subject.id}`,
  via: actor.act === undefined ? "person" as const : "agent" as const,
  login: actor.login ?? actor.subject.id,
})



const AfterSeq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: JOURNAL_PAGE }))
const decodeAfterSeq = Schema.decodeUnknownOption(Schema.NumberFromString.pipe(Schema.decodeTo(AfterSeq)))
const decodeLimit = Schema.decodeUnknownOption(Schema.NumberFromString.pipe(Schema.decodeTo(Limit)))

/** A query parameter as a number within its bounds: its default when absent, none when it isn't one. */
const parameter = (
  query: URLSearchParams,
  name: string,
  decode: (text: string) => Option.Option<number>,
  fallback: number,
): Option.Option<number> => {
  const text = query.get(name)
  return text === null ? Option.some(fallback) : decode(text)
}

/** The TODO attempt whose run `runId` is, if a TODO's attempt started it: `todo:<attempt id>`. */
const attemptOf = (runId: string) =>
  Effect.gen(function* () {
    if (!isRemoteRun(runId)) return Option.none<string>()
    const sql = yield* SqlClient.SqlClient
    const attemptId = runId.slice("todo:".length)
    const rows = yield* sql<{ readonly id: string }>`SELECT id::text FROM todo_attempts WHERE id = ${attemptId}::uuid`
    return Option.map(Option.fromNullishOr(rows[0]), (row) => row.id)
  })

/** How many of an inspection's values were cut to their limit. */
const clippedValues = (inspection: EngineStore.RunInspection.Inspection): number =>
  [
    inspection.run.input,
    inspection.run.result,
    ...inspection.steps.flatMap((step) => [step.output, ...step.attempts.map((attempt) => attempt.outcome)]),
    ...inspection.children.flatMap((child) => [child.input, child.result]),
    ...inspection.journal.events.map((event) => event.payload),
  ].filter((value) => value?.clipped === true).length

class NotWorking extends Data.TaggedError("NotWorking")<{}> {}

const noStore = { "cache-control": "no-store" }

/**
 * Reads Electric's connection and returns the routes over `database`, the app's tables (`todo_attempts`), and `engine`.
 * They read who is asking from `Sessions`.
 */
export const make = <E, R, EE, ER, RS>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  engine: Engine<EE, ER, RS>,
  /** Resolves the asker's role on the recorded run's repository. */
  roles: RepoRoles.RepoRoles<R>,
) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    // The deployment's system flows an Admin reads are rendered through their own declarations too.
    const inspection = EngineStore.RunInspection.layerWith({ flows: [...engine.flows, ...CloudRuns.SYSTEM_FLOWS] })
    // The run's queue, over the engine's own journal in its schema. The route runs no migrations (the engine owns
    // them) and remembers one journal event at startup, not the journal's default thousands: it admits one steer.
    const queue = Layer.provideMerge(inspection, NotificationQueue.layer.pipe(
      Layer.provideMerge(Journal.SqlJournal.layer({ capacity: 1024, overflow: "reject", sourceEventCache: 1 }).pipe(
        Layer.provideMerge(Layer.provideMerge(Database.DurableWriter.layer(), engine.writer)),
      )),
    ))

    /** A run's access comes from its recorded repository, never the deployment's session role on another one. */
    const access = (runId: string, actor: Actor) => Effect.gen(function* () {
      const ownRole = mayRead(Option.some(actor))
      // TODO admission keeps its existing policy; repository flows may also be named `todo`.
      if (isRemoteRun(runId) && Option.isSome(yield* attemptOf(runId))) {
        return { allowed: ownRole, watched: true, repoRun: Option.none<RepoRuns.Admitted>() }
      }
      const admitted = yield* RepoRuns.admit(runId, engine.database)
      if (Option.isNone(admitted)) {
        // An Admin reads the deployment's own system flows (worker/CloudRuns.ts), and only those.
        const system = actor.role === "admin" && (yield* Effect.flatMap(
          EngineStore.RunInspection.RunInspection,
          (reads) => reads.list({ runIds: [runId], flows: CloudRuns.SYSTEM_FLOW_TAGS, roots: false, limit: 1 }),
        ).pipe(Effect.provide(inspection), Effect.provide(engine.database))).runs.length === 1
        return { allowed: ownRole || system, watched: system, repoRun: admitted }
      }
      const resolved = yield* roles.resolve(actor, repositoryOf(admitted.value.repoId.slice("github/".length))).pipe(
        Effect.map(Option.some),
        Effect.catch((error) => RepoRoles.REFUSALS[error.code] === 503 || error.code === "rate_limited"
          ? Effect.fail(error) : Effect.succeed(Option.none())),
      )
      const permitted = Option.isSome(resolved) && mayRead(Option.some({ ...actor, role: resolved.value.role }))
      return { allowed: ownRole || permitted, watched: permitted, repoRun: permitted ? admitted : Option.none<RepoRuns.Admitted>() }
    }).pipe(Effect.provide(database))

    /** `POST /api/remote-runs/<runId>/stop`: a repository's run, stopped on its Durable Object. */
    const stop = (runId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = { host: "remote", runId }
        const refused = (status: number, code: StopRefusal) => {
          fields.outcome = code
          return HttpServerResponse.jsonUnsafe({ code }, {
            status,
            headers: status === 503 ? { ...noStore, "retry-after": String(ShapeAccess.RETRY_AFTER_SECONDS) } : noStore,
          })
        }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "POST") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          }
          const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
          if (Option.isNone(actor)) return refused(503, "unavailable")
          if (Option.isNone(actor.value)) return refused(401, "authentication")
          // A Member or above, in person or through an agent acting for them (ruling FLOW-3): stopping neither
          // approves nor merges.
          const admitted = yield* access(runId, actor.value.value)
          if (!admitted.allowed) return refused(403, "forbidden")
          fields.via = actor.value.value.act === undefined ? "person" : "agent"
          // Only a repository's run itself: a job stops with its run.
          if (Option.isNone(admitted.repoRun) || admitted.repoRun.value.execution !== runId) return refused(404, "not_found")
          // A run that ended has nothing to stop. One its object hasn't begun is stopped before it starts.
          const status = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql<{ readonly status: string }>`SELECT status FROM flows_runs WHERE run_id = ${runId}`).pipe(
              Effect.provide(engine.database),
            )
          const outcome = status[0] !== undefined && settled(status[0].status) ? "settled" as const : "requested" as const
          if (outcome === "requested") yield* engine.stop(runId)
          fields.outcome = outcome
          return HttpServerResponse.jsonUnsafe({ outcome }, { status: outcome === "requested" ? 202 : 200, headers: noStore })
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refused(503, "unavailable")
            })
          ),
        )
        const outcome = String(fields.outcome)
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(stops, { outcome }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.run.host": "remote", outcome })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "run.stop",
        ).pipe(Effect.annotateLogs({ ...fields, outcome }))
        return response
      }).pipe(Effect.withSpan("run.stop", { kind: "server" }))

    /** `POST /api/remote-runs/<runId>/steers`. */
    const steer = (runId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = { host: "remote" }
        const refused = (status: number, code: SteerRefusal) => {
          fields.outcome = code
          return HttpServerResponse.jsonUnsafe({ code }, {
            status,
            headers: status === 503 ? { ...noStore, "retry-after": String(ShapeAccess.RETRY_AFTER_SECONDS) } : noStore,
          })
        }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "POST") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          }
          const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
          if (Option.isNone(actor)) return refused(503, "unavailable")
          if (Option.isNone(actor.value)) return refused(401, "authentication")
          // A Member or above, in person or through an agent acting for them (ruling FLOW-3): steering neither commits,
          // approves nor merges.
          if (!mayRead(actor.value)) return refused(403, "forbidden")
          const steerer = steererOf(actor.value.value)
          fields.via = steerer.via
          const text = yield* readBounded(request, MAX_STEER_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
            Effect.result,
          )
          if (text._tag === "Failure") return refused(text.failure.reason === "too_large" ? 413 : 400, text.failure.reason === "too_large" ? "too_large" : "invalid")
          const body = decodeSteerBody(text.success)
          if (Option.isNone(body)) return refused(400, "invalid")
          if (body.value.body.trim() === "") return refused(400, "invalid")
          if (
            body.value.body.length > MAX_STEER_CHARS ||
            new TextEncoder().encode(JSON.stringify(body.value.body)).length > MAX_STEER_JSON_BYTES
          ) return refused(413, "too_large")
          const id = body.value.id.toLowerCase()
          fields.steerId = id
          const attempt = yield* attemptOf(runId).pipe(Effect.provide(database))
          if (Option.isNone(attempt)) return refused(404, "not_found")
          fields.runId = runId
          const admitted = yield* Effect.gen(function* () {
            const journal = yield* Journal.Journal.Journal
            const notifications = yield* NotificationQueue.NotificationQueue
            const reads = yield* EngineStore.RunInspection.RunInspection
            return yield* journal.transact(Effect.gen(function* () {
              // Admission resolves durable identity first. A duplicate keeps its
              // receipt even after completion; a new steer is rolled back unless
              // the run is steerable under this same engine writer transaction.
              const receipt = yield* notifications.admit(
                runId,
                Notification.humanSteer({
                  runId,
                  id,
                  actor: steerer.actor,
                  attribution: { login: steerer.login, via: steerer.via },
                  payload: SteerPayload.encode({ kind: "Message", body: body.value.body }),
                }),
              )
              if (!receipt.duplicate) {
                const read = yield* reads.inspect(runId, { limit: 1 }).pipe(
                  Effect.catchIf(
                    (error) => Predicate.isTagged(error, "@smthrs/engine-store/RunNotFound"),
                    () => Effect.fail(new NotWorking()),
                  ),
                )
                if (!steerable(read.run, read.steps)) return yield* new NotWorking()
              }
              return receipt
            }))
          }).pipe(Effect.provide(queue), Effect.scoped, Effect.result)
          if (admitted._tag === "Failure") {
            const failure = admitted.failure
            if (Predicate.isTagged(failure, "NotWorking")) return refused(409, "not_working")
            if (Predicate.isTagged(failure, "/notifications/NotificationError") && failure.code === "notification_id_reused") {
              return refused(409, "conflict")
            }
            fields.errorCode = codeOf(failure)
            return refused(503, "unavailable")
          }
          if (admitted.success.decision === "rejected-full") return refused(429, "full")
          fields.outcome = admitted.success.duplicate ? "existing" : "taken"
          return HttpServerResponse.jsonUnsafe(
            { id, seq: admitted.success.seq },
            { status: admitted.success.duplicate ? 200 : 202, headers: noStore },
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refused(503, "unavailable")
            })
          ),
        )
        const outcome = String(fields.outcome)
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(steers, { outcome }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.run.host": "remote", outcome })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "run.steer",
        ).pipe(Effect.annotateLogs({ ...fields, outcome }))
        return response
      }).pipe(Effect.withSpan("run.steer", { kind: "server" }))

    /** `GET /api/remote-runs/<runId>`. */
    const read = (runId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = { host: "remote" }
        const refused = (status: number, code: RemoteReadRefusal) => {
          fields.outcome = code
          return HttpServerResponse.jsonUnsafe({ code }, {
            status,
            headers: status === 503 ? { ...noStore, "retry-after": String(ShapeAccess.RETRY_AFTER_SECONDS) } : noStore,
          })
        }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "GET") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
          }
          const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
          if (Option.isNone(actor)) return refused(503, "unavailable")
          if (Option.isNone(actor.value)) return refused(401, "authentication")
          const admitted = yield* access(runId, actor.value.value)
          if (!admitted.allowed) return refused(403, "forbidden")
          const query = new URL(request.url, "http://localhost").searchParams
          const afterSeq = parameter(query, "afterSeq", decodeAfterSeq, -1)
          const limit = parameter(query, "limit", decodeLimit, JOURNAL_PAGE)
          if (Option.isNone(afterSeq) || Option.isNone(limit)) return refused(400, "invalid")
          if (!admitted.watched) return refused(404, "not_found")
          fields.runId = runId
          const read = yield* Effect.flatMap(
            EngineStore.RunInspection.RunInspection,
            (reads) => reads.inspect(runId, { afterSeq: afterSeq.value, limit: limit.value }),
          ).pipe(Effect.provide(inspection), Effect.provide(engine.database), Effect.result)
          if (read._tag === "Failure") {
            if (Predicate.isTagged(read.failure, "@smthrs/engine-store/RunNotFound")) return refused(404, "not_started")
            fields.errorCode = codeOf(read.failure)
            return refused(503, "unavailable")
          }
          const body = JSON.stringify(read.success)
          fields.outcome = "read"
          fields.events = read.success.journal.events.length
          fields.bytes = new TextEncoder().encode(body).length
          fields.clipped = clippedValues(read.success)
          return HttpServerResponse.text(body, { contentType: "application/json", headers: noStore })
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refused(503, "unavailable")
            })
          ),
        )
        const outcome = String(fields.outcome)
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(reads, { outcome }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.run.host": "remote", outcome })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "run.inspect",
        ).pipe(Effect.annotateLogs({ ...fields, outcome }))
        return response
      }).pipe(Effect.withSpan("run.inspect", { kind: "server" }))

    /** `GET /api/shapes/remote-runs?run=<runId>`: the run's row of the change feed, for a Member; refused otherwise. */
    const changes = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const actor = yield* ShapeAccess.actor
        if (Option.isNone(actor)) return yield* new ShapeProxy.Refused({ status: 401 })
        const runId = new URL(request.url, "http://localhost").searchParams.get("run") ?? ""
        const admitted = yield* access(runId, actor.value).pipe(Effect.mapError(() => ShapeAccess.unavailable))
        // A run no TODO and no repository started is no Member's to follow.
        if (!admitted.allowed || !admitted.watched) return yield* new ShapeProxy.Refused({ status: 403 })
        return {
          table: `${engine.schema}.${RUN_CHANGES_TABLE}`,
          where: "run_id = $1",
          params: { "1": runId },
          columns: RUN_CHANGE_COLUMNS,
        }
      }),
      name: "runs.shape.remote",
      metric: shapeRequests,
    })

    /** `GET /api/cloud-runs`: the runs on Cloudflare the asker may read (worker/CloudRuns.ts). */
    const list = CloudRuns.route({ database, engine: engine.database, inspection, roles })

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (path === REMOTE_RUN_SHAPE_ROUTE) return yield* changes
      if (path === CLOUD_RUNS_ROUTE) return yield* list
      const steered = parseSteerPath(path)
      if (steered !== undefined) return yield* steer(steered)
      const stopped = parseStopPath(path)
      if (stopped !== undefined) return yield* stop(stopped)
      const runId = parseRunPath(path)
      return runId === undefined ? HttpServerResponse.empty({ status: 404 }) : yield* read(runId)
    })
    return { fetch }
  })
