import { forgeOf, namespaceOf } from "./Conversations.ts"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import {
  MAX_OPEN_BODY_BYTES,
  ADMIT_WAIT_SECONDS,
  OPEN_DEADLINE_SECONDS,
  openExecutionId,
  TERMINALS_TABLE,
} from "../../src/features/terminal/contract.ts"
import type { Actor } from "../Actor.ts"
import { refusesPersonOnly, canAsk, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import { TerminalOpen } from "../flows/TerminalOpen.ts"
import * as ShapeAccess from "../ShapeAccess.ts"
import { branchAccess, canEdit, canView } from "./Access.ts"
import { TerminalSockets } from "./Sandboxes.ts"
import { isUpgrade, sameOrigin } from "./Upgrade.ts"

// The terminal routes (decision 0013 §2-§3, docs/features/branch-workspace.md#the-terminal):
//
// - `POST /api/terminals { terminalId, branchId, cols, rows }`: the write path of the client flow `terminal/open`. It
//   admits the open (signed in, may edit the branch, a branch that isn't locked), records the `opening` row, and
//   starts the remote `terminal/Open`, one execution per terminal. A person has one terminal per branch: while theirs
//   opens or is open, the answer names it instead.
// - `GET /api/shapes/terminals?branch=<id>`: the branch's terminals, for everyone who may view it.
// - `GET /api/terminals/<id>` with `Upgrade: websocket`: attaches the page's socket to the terminal's shell: anyone who
//   may edit the branch types, its owner and the people it is shared with to edit alike, and anyone who may only view
//   it reads. Only this app's own pages may: the `Origin` must be the request's.
//
// Who may do what is worker/branch/Access.ts's, decided at every request; a change of sharing reaches the sockets
// already open through `TerminalSockets.enforce` (worker/branch/Shares.ts).
//
// The shell's bytes never reach a log line, a span or a metric: only ids, access, outcomes and statuses.

/** Terminal route requests, by `route` (`open`, `connect`) and `outcome`. */
export const requests = Metric.counter("smithers_terminal_requests", {
  description: "Requests to the terminal routes, by route and outcome",
  incremental: true,
})

/** `GET /api/shapes/terminals` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_terminal_shape_requests", {
  description: "GET /api/shapes/terminals requests, by status and live",
  incremental: true,
})

const Open = Schema.Struct({
  terminalId: Schema.String.check(Schema.isUUID()),
  branchId: Schema.String.check(Schema.isUUID()),
  cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
})
const decodeOpen = Schema.decodeUnknownEffect(Schema.fromJsonString(Open))
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

/** What a shape filters on for someone who may not watch: no branch's id, so it holds no rows. */
const NO_BRANCH = "00000000-0000-0000-0000-000000000000"

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code, ...(code === "members_only" ? { message: "Members can run machines." } : {}) }, { status, headers: noStore })

type Fields = Record<string, string | number | boolean>

/** A repository id's owner and name: `github/<owner>/<name>`. */
const partsOf = (repoId: string) => {
  const [, owner = "", name = ""] = repoId.split("/")
  return { owner, name }
}

/** The person's live terminal on the branch, if they have one: its id. */
const liveOf = (branchId: string, ownerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly id: string; readonly status: string }>`
      SELECT id, status FROM terminal_sessions
      WHERE branch_id = ${branchId} AND owner_id = ${ownerId} AND status IN ('opening', 'open')`
    return row
  })

/**
 * Records terminal `terminalId` as `opening` for `actor` on `branchId`, unless they have one there already, and drops
 * their ended ones there: `{ created }` with the terminal's id, theirs or this one.
 */
const admit = (terminalId: string, branchId: string, actor: Actor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      // An open that never finished in time (its run stopped, or never started) settles failed here, so it can't lock
      // the person out of the branch; `terminal/Open` no longer records it open either (worker/flows/TerminalOpen.ts).
      // One waiting for a free machine has the wait's time first (`ADMIT_WAIT_SECONDS`).
      yield* sql`
        UPDATE terminal_sessions SET status = 'failed', failure = 'unavailable', ended_at = now(), updated_at = now()
        WHERE branch_id = ${branchId} AND owner_id = ${actor.subject.id} AND status = 'opening'
          AND CASE WHEN waiting
            THEN created_at <= now() - make_interval(secs => ${ADMIT_WAIT_SECONDS + OPEN_DEADLINE_SECONDS})
            ELSE coalesce(admitted_at, created_at) <= now() - make_interval(secs => ${OPEN_DEADLINE_SECONDS}) END`
      const [inserted] = yield* sql<{ readonly id: string }>`
        INSERT INTO terminal_sessions (id, branch_id, owner_id, owner_login, owner_role, status)
        VALUES (${terminalId}, ${branchId}, ${actor.subject.id}, ${actor.login ?? actor.subject.id}, ${actor.role},
          'opening')
        ON CONFLICT DO NOTHING
        RETURNING id`
      if (inserted !== undefined) {
        yield* sql`
          DELETE FROM terminal_sessions
          WHERE branch_id = ${branchId} AND owner_id = ${actor.subject.id} AND status IN ('ended', 'failed')`
        return { created: true, terminalId }
      }
      const [same] = yield* sql<{ readonly id: string }>`
        SELECT id FROM terminal_sessions
        WHERE id = ${terminalId} AND branch_id = ${branchId} AND owner_id = ${actor.subject.id}`
      if (same !== undefined) return { created: false, terminalId }
      const live = yield* liveOf(branchId, actor.subject.id)
      return live === undefined ? undefined : { created: false, terminalId: live.id }
    }))
  })

/** Ends terminal `terminalId` as `lost` if it is still open: its machine no longer has its session. */
const markLost = (terminalId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      UPDATE terminal_sessions SET status = 'ended', ended_reason = 'lost', ended_at = now(), updated_at = now()
      WHERE id = ${terminalId} AND status IN ('opening', 'open')`)

/**
 * Reads Electric's connection and returns the terminal routes over `database`, which opens a Postgres client for each
 * request's scope. They read who is asking from `Sessions`, start `terminal/Open` through `Flows.FlowStarter`, and
 * reach the machine through `TerminalSockets`.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })

    /** One request's records: a log line `terminal.<route>`, its span's status, and a count. */
    const recorded = <RR>(
      route: "open" | "connect",
      run: (fields: Fields) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, RR>,
    ) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Fields = {}
        const response = yield* run(fields)
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        // Every answer below 400 names its outcome; a refusal is its code, and a 405 has none.
        const outcome = String(fields.outcome ?? fields.code ?? "refused")
        yield* Metric.update(Metric.withAttributes(requests, { route, outcome }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          `terminal.${route}`,
        ).pipe(Effect.annotateLogs({ ...fields, outcome }))
        return response
      }).pipe(Effect.withSpan(`terminal.${route}`, { kind: "server" }))

    const refuse = (fields: Fields, status: number, code: string) => {
      fields.code = code
      return refusal(status, code)
    }

    /** `POST /api/terminals`. */
    const open = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const sessions = yield* Sessions
      const starter = yield* Flows.FlowStarter
      return yield* recorded("open", (fields) =>
        Effect.gen(function* () {
          if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          const actor = yield* sessions.resolve.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
          if (Option.isNone(actor)) return refuse(fields, 401, "authentication")
          // A terminal is the person's own shell; the agent runs commands as jobs (decision 0017 slice 0).
          if (yield* refusesPersonOnly(actor.value, "terminal/open")) return refuse(fields, 403, "person_only")
          const body = yield* readBounded(request, MAX_OPEN_BODY_BYTES).pipe(Effect.result)
          if (body._tag === "Failure") return refuse(fields, body.failure.reason === "too_large" ? 413 : 400, "invalid")
          const decoded = yield* decodeOpen(body.success).pipe(Effect.option)
          if (Option.isNone(decoded)) return refuse(fields, 400, "invalid")
          const terminalId = decoded.value.terminalId.toLowerCase()
          const branchId = decoded.value.branchId.toLowerCase()
          fields.terminalId = terminalId
          fields.branchId = branchId
          const branch = yield* branchAccess(actor, branchId).pipe(Effect.provide(database))
          if (branch === undefined) return refuse(fields, 404, "not_found")
          if (!canEdit(branch.access)) return refuse(fields, 403, "forbidden")
          if (!canAsk(actor.value)) return refuse(fields, 403, "members_only")
          // No terminal on a locked branch, nor yet on a restricted one, whose writers come with 0007's modes.
          if (branch.mode !== "open") return refuse(fields, 409, "locked")
          // The terminal keeps the role on the branch's repository its host re-checks shares with (decision 0079).
          const admitted = yield* admit(terminalId, branchId, { ...actor.value, role: branch.role }).pipe(
            Effect.provide(database),
          )
          if (admitted === undefined) return refuse(fields, 409, "id_taken")
          if (admitted.terminalId === terminalId) {
            const { owner, name } = partsOf(branch.repoId)
          const namespace = yield* namespaceOf(branch.branchId).pipe(Effect.provide(database))
          const forge = yield* forgeOf(branch.branchId).pipe(Effect.provide(database))
            // A resend starts the same execution, a no-op, so an open whose first start was lost still gets one.
            const started = yield* starter.start(TerminalOpen, {
              executionId: openExecutionId(terminalId),
              payload: {
                terminalId,
                ownerId: actor.value.subject.id,
                branch: { branchId, owner, name, branch: branch.name, ...(namespace === "ephemeral" ? { namespace } : {}), ...(forge === undefined ? {} : { forge }) },
              },
            }).pipe(Effect.result)
            if (started._tag === "Failure") {
              fields.errorCode = started.failure._tag
              return refuse(fields, 503, "unavailable")
            }
          }
          fields.outcome = admitted.created ? "opening" : "existing"
          return HttpServerResponse.jsonUnsafe(
            { terminalId: admitted.terminalId },
            { status: admitted.created ? 202 : 200, headers: noStore },
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refuse(fields, 503, "unavailable")
            })
          ),
        ))
    })

    /** `GET /api/shapes/terminals?branch=<id>`; sessions unreadable, 503 (worker/ShapeAccess.ts). */
    const shape = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const named = new URL(request.url, "http://localhost").searchParams.get("branch")
        const actor = yield* ShapeAccess.actor
        const found = named !== null && isUuid(named)
          ? yield* branchAccess(actor, named.toLowerCase()).pipe(
            Effect.provide(database),
            Effect.mapError(() => ShapeAccess.unavailable),
          )
          : undefined
        const branch = found !== undefined && canView(found.access) ? found.branchId : NO_BRANCH
        return { table: TERMINALS_TABLE, where: "branch_id = $1", params: { "1": branch } }
      }),
      name: "terminal.shape",
      metric: shapes,
    })

    /** `GET /api/terminals/<id>`: the socket. */
    const connect = (terminalId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const sessions = yield* Sessions
        const sockets = yield* TerminalSockets
        return yield* recorded("connect", (fields) =>
          Effect.gen(function* () {
            if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
            if (!isUpgrade(request)) return refuse(fields, 426, "upgrade")
            if (!sameOrigin(request)) return refuse(fields, 403, "origin")
            if (!isUuid(terminalId)) return refuse(fields, 404, "not_found")
            fields.terminalId = terminalId.toLowerCase()
            const actor = yield* sessions.resolve.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
            const [row] = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql<{ readonly branchId: string; readonly ownerId: string; readonly status: string }>`
                SELECT branch_id AS "branchId", owner_id AS "ownerId", status FROM terminal_sessions
                WHERE id = ${terminalId.toLowerCase()}`).pipe(Effect.provide(database))
            if (row === undefined) return refuse(fields, 404, "not_found")
            if (Option.isNone(actor)) return refuse(fields, 401, "authentication")
            const branch = yield* branchAccess(actor, row.branchId).pipe(Effect.provide(database))
            // A terminal's branch is never deleted while its rows stand (the foreign key).
            if (!canView(branch!.access)) return refuse(fields, 403, "forbidden")
            if (!canAsk(actor.value)) return refuse(fields, 403, "members_only")
            const access = canEdit(branch!.access) ? "write" : "read"
            fields.access = access
            if (row.status !== "open") return refuse(fields, 409, row.status)
            if (!(yield* sockets.alive(row.branchId, terminalId.toLowerCase(), row.ownerId))) {
              yield* markLost(terminalId.toLowerCase()).pipe(Effect.provide(database))
              return refuse(fields, 410, "lost")
            }
            const attachment = {
              terminalId: terminalId.toLowerCase(),
              ownerId: row.ownerId,
              access,
              principal: actor.value.subject.id,
              role: branch!.role,
            } as const
            const attached = yield* sockets.attach(row.branchId, attachment)
              .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
            fields.outcome = "attached"
            return attached
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                fields.errorCode = codeOf(Cause.squash(cause))
                return refuse(fields, 503, "unavailable")
              })
            ),
          ))
      })

    return { open, shape, connect }
  })
