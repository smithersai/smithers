import { ShapeProxy } from "@smthrs/effect-electric"
import { SharedText } from "@smthrs/sync"
import { Cause, Clock, Effect, type Layer, Metric, Option, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import {
  HOME,
  MAX_TEXT_BODY_BYTES,
  MAX_UPDATE_LENGTH,
  TEXT_UPDATE_COLUMNS,
  TEXT_UPDATES_TABLE,
  TEXTS_ROUTE,
  TEXTS_SHAPE_ROUTE,
  type TextScope,
} from "../../src/features/coedit/contract.ts"
import type { Access } from "../../src/features/branch/contract.ts"
import { type Actor, type Role, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as ShapeAccess from "../ShapeAccess.ts"
import { askingOf, branchAccess, canEdit, canView, installedOn, isMember, roleOn, type Policy } from "./Access.ts"
import * as Conversations from "./Conversations.ts"
import { Rooms } from "./Rooms.ts"
import { isUpgrade, sameOrigin } from "./Upgrade.ts"

// Co-editing's routes (decision 0013 §4, docs/features/coedit.md): every input two people see at once is a text they
// edit together (`@smthrs/sync`'s `SharedText`), with each other's cursors.
//
// - `POST /api/texts/<text id> { scope, id, update, seed? }`: adds one update, for someone who may edit the text. A
//   viewer's update is refused here, before it is stored.
// - `GET /api/shapes/texts?text=<id>&<scope>`: the text's updates, for everyone who may see it.
// - `GET /api/texts/<text id>/room?<scope>` with `Upgrade: websocket`: the text's cursors, a presence room (one
//   `RoomObject` per text, worker/BranchRooms.ts) that only the people who may see the text join.
//
// A text's scope decides who may: a conversation's text follows its branch's sharing (worker/branch/Access.ts), and a
// run's answer box is its person's alone. Every request decides again, so a person who loses a branch is refused at
// once, and a change of sharing closes their place in its texts' rooms (`enforceRooms`, from worker/branch/Shares.ts).
//
// An update is content: it is stored and synced, never logged. Records carry ids, sizes, scopes' kinds and outcomes.

/** `POST /api/texts/<id>` requests, by `outcome`: `stored`, `existing`, or the refusal's code. */
export const writes = Metric.counter("smithers_text_writes", {
  description: "POST /api/texts/<id> requests, by outcome",
  incremental: true,
})

/** `GET /api/shapes/texts` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_text_shape_requests", {
  description: "GET /api/shapes/texts requests, by status and live",
  incremental: true,
})

/** `GET /api/texts/<id>/room` requests, by `outcome`: `joined`, or the refusal's code. */
export const joins = Metric.counter("smithers_text_room_joins", {
  description: "GET /api/texts/<id>/room requests, by outcome",
  incremental: true,
})

const Uuid = Schema.String.check(Schema.isUUID())
const isUuid = Schema.is(Uuid)
const Scope = Schema.Union([
  Schema.Struct({ conversation: Schema.Union([Uuid, Schema.Literal(HOME)]) }),
  Schema.Struct({ run: Uuid }),
])
const Write = Schema.Struct({
  scope: Scope,
  id: Uuid,
  update: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_UPDATE_LENGTH)),
  seed: Schema.optional(Schema.Boolean),
})
const decodeWrite = Schema.decodeUnknownEffect(Schema.fromJsonString(Write))
const isScope = Schema.is(Scope)

/** What a shape filters on for someone who may not see the text, or names none: no scope and no text, so no rows. */
const NO_SCOPE = "none"
const NO_TEXT = "00000000-0000-0000-0000-000000000000"

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })

type Fields = Record<string, string | number | boolean>

/**
 * Where a text's updates are kept, and what `actor` may do with it: `branch:<id>` for a conversation's text, with the
 * person's access to the branch; `run:<id>` for a run's answer box, `owner` for its person and nothing for anyone
 * else. `undefined` when there is no such conversation or run.
 */
export interface Scoped {
  readonly key: string
  readonly kind: "conversation" | "run"
  readonly access: Access | "none"
  /** The role `access` was decided with: on a branch's repository for a conversation's text (decision 0079). */
  readonly role: Role | null
}

/** `actor`'s access to a text in `scope`. */
export const scopeAccess = (actor: Option.Option<Actor>, scope: TextScope) =>
  Effect.gen(function* () {
    if ("run" in scope) {
      const sql = yield* SqlClient.SqlClient
      const [run] = yield* sql<{ readonly launchedBy: string; readonly conversationId: string | null; readonly branchId: string | null; readonly repoId: string | null }>`
        SELECT r.launched_by AS "launchedBy", coalesce(r.conversation_id, m.conversation_id) AS "conversationId", r.branch_id AS "branchId", r.repo_id AS "repoId"
        FROM runs r LEFT JOIN messages m ON m.id = r.id WHERE r.id = ${scope.run.toLowerCase()}`
      if (run === undefined) return undefined
      const key = `run:${scope.run.toLowerCase()}`
      if (Option.isNone(actor) || actor.value.subject.id !== run.launchedBy) {
        return { key, kind: "run", access: "none", role: null } satisfies Scoped
      }
      // Only genuinely unscoped historical runs use home. A missing/deleted linked branch never changes repository.
      const conversation = run.conversationId ?? (run.repoId === null && run.branchId === null ? yield* Conversations.home : undefined)
      const branch = conversation !== undefined
        ? yield* branchAccess(actor, conversation, "conversation")
        : run.branchId !== null ? yield* branchAccess(actor, run.branchId) : undefined
      const repositoryOnly = conversation === undefined && run.branchId === null && run.repoId !== null
      const role = repositoryOnly
        ? yield* roleOn(actor.value, run.repoId!, yield* installedOn(run.repoId!))
        : branch?.role ?? null
      const access = repositoryOnly
        ? isMember(Option.some({ ...actor.value, role })) ? "owner" : "none"
        : branch !== undefined && askingOf(branch) === "ask" ? "owner" : "none"
      return {
        key,
        kind: "run",
        access,
        role,
      } satisfies Scoped
    }
    const conversation = scope.conversation === HOME ? yield* Conversations.home : scope.conversation.toLowerCase()
    if (conversation === undefined) return undefined
    const branch = yield* branchAccess(actor, conversation, "conversation")
    if (branch === undefined) return undefined
    return { key: `branch:${branch.branchId}`, kind: "conversation", access: branch.access, role: branch.role } satisfies Scoped
  })

/** The scope a query string names: `conversation=<id | home>` or `run=<id>`. */
const scopeOfQuery = (url: string): TextScope | undefined => {
  const params = new URL(url, "http://localhost").searchParams
  const conversation = params.get("conversation")
  const run = params.get("run")
  const scope = conversation !== null ? { conversation } : run !== null ? { run } : undefined
  return isScope(scope) ? scope : undefined
}

/** The presence room of text `textId` kept under `key`: one `RoomObject` per text. */
export const roomOf = (key: string, textId: string): string => `text:${key}:${textId.toLowerCase()}`

/**
 * Holds everyone in the rooms of branch `branchId`'s texts to its permission list as it now stands, as the branch's own
 * room is: someone who may no longer view it leaves for good. Texts nobody has written to have no content to keep.
 */
export const enforceRooms = (branchId: string, policy: Policy) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const key = `branch:${branchId}`
    const texts = yield* sql<{ readonly textId: string }>`
      SELECT DISTINCT text_id AS "textId" FROM text_updates WHERE scope = ${key}`
    const rooms = yield* Rooms
    yield* Effect.forEach(texts, ({ textId }) => rooms.enforce(roomOf(key, textId), policy), { discard: true })
  })

/** Whether a path is one of co-editing's routes. */
export const handles = (path: string): boolean =>
  path === TEXTS_SHAPE_ROUTE || path.startsWith(`${TEXTS_ROUTE}/`)

/** `/api/texts/<id>` or `/api/texts/<id>/room`: the text's id and which. */
const textPath = (path: string) => {
  const match = /^\/api\/texts\/([^/]+)(\/room)?$/.exec(path)
  return match === null ? undefined : { textId: match[1]!, room: match[2] !== undefined }
}

/** Inserts one update, once: the transaction it went in, or `null` when it, or the text's seed, was there already. */
const insert = (scope: string, textId: string, write: typeof Write.Type, personId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const stored = yield* sql`
        INSERT INTO text_updates (id, scope, text_id, data, seed, person_id)
        VALUES (${write.id.toLowerCase()}, ${scope}, ${textId}, ${write.update}, ${write.seed === true}, ${personId})
        ON CONFLICT DO NOTHING
        RETURNING id`
      if (stored.length === 0) return null
      const [row] = yield* sql<{ readonly txid: string }>`SELECT pg_current_xact_id()::xid::text AS txid`
      return Number(row!.txid)
    }))
  })

/** One request's records: a log line `text.<route>`, its span's status, and a count by outcome. */
const recorded = <R>(
  route: "write" | "room",
  counter: typeof writes,
  run: (fields: Fields) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const fields: Fields = {}
    const response = yield* run(fields)
    fields.status = response.status
    fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
    const outcome = String(fields.outcome ?? fields.code ?? "method")
    yield* Metric.update(Metric.withAttributes(counter, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      `text.${route}`,
    ).pipe(Effect.annotateLogs({ ...fields, outcome }))
    return response
  }).pipe(Effect.withSpan(`text.${route}`, { kind: "server" }))

const refuse = (fields: Fields, status: number, code: string) => {
  fields.code = code
  return refusal(status, code)
}

const unavailable = (fields: Fields) => (cause: Cause.Cause<unknown>) =>
  Effect.sync(() => {
    fields.errorCode = codeOf(Cause.squash(cause))
    return refuse(fields, 503, "unavailable")
  })

/**
 * Reads Electric's connection and returns co-editing's routes over `database`, which opens a Postgres client for each
 * request's scope. They read who is asking from `Sessions`, and reach a text's room through `Rooms`.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })

    /** `POST /api/texts/<id>`. */
    const write = (textId: string) =>
      recorded("write", writes, (fields) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          const actor = yield* (yield* Sessions).resolve
          if (Option.isNone(actor)) return refuse(fields, 401, "authentication")
          if (!isUuid(textId)) return refuse(fields, 404, "not_found")
          fields.textId = textId.toLowerCase()
          const body = yield* readBounded(request, MAX_TEXT_BODY_BYTES).pipe(Effect.result)
          if (body._tag === "Failure") return refuse(fields, body.failure.reason === "too_large" ? 413 : 400, "invalid")
          const decoded = yield* decodeWrite(body.success).pipe(Effect.option)
          if (Option.isNone(decoded)) return refuse(fields, 400, "invalid")
          const scoped = yield* scopeAccess(actor, decoded.value.scope).pipe(Effect.provide(database))
          if (scoped === undefined) return refuse(fields, 404, "not_found")
          fields.scope = scoped.kind
          if (!canView(scoped.access)) return refuse(fields, 403, "forbidden")
          if (!canEdit(scoped.access)) return refuse(fields, 403, "view_only")
          const bytes = Base64.decode(decoded.value.update)
          if (Result.isFailure(bytes)) return refuse(fields, 400, "invalid")
          fields.bytes = bytes.success.byteLength
          fields.seed = decoded.value.seed === true
          const valid = yield* SharedText.validate(bytes.success, { seed: decoded.value.seed === true }).pipe(Effect.result)
          if (Result.isFailure(valid)) return refuse(fields, 400, "invalid")
          const txid = yield* insert(scoped.key, textId.toLowerCase(), decoded.value, actor.value.subject.id).pipe(
            Effect.provide(database),
          )
          fields.outcome = txid === null ? "existing" : "stored"
          return HttpServerResponse.jsonUnsafe({ txid }, { headers: noStore })
        }).pipe(Effect.catchCause(unavailable(fields))))

    /** `GET /api/texts/<id>/room`. */
    const room = (textId: string) =>
      recorded("room", joins, (fields) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
          if (!isUpgrade(request)) return refuse(fields, 426, "upgrade")
          if (!sameOrigin(request)) return refuse(fields, 403, "origin")
          const scope = scopeOfQuery(request.url)
          if (!isUuid(textId) || scope === undefined) return refuse(fields, 404, "not_found")
          fields.textId = textId.toLowerCase()
          const actor = yield* (yield* Sessions).resolve
          if (Option.isNone(actor)) return refuse(fields, 401, "authentication")
          const scoped = yield* scopeAccess(actor, scope).pipe(Effect.provide(database))
          if (scoped === undefined) return refuse(fields, 404, "not_found")
          fields.scope = scoped.kind
          if (!canView(scoped.access)) return refuse(fields, 403, "forbidden")
          fields.access = scoped.access
          const joined = yield* (yield* Rooms).join(roomOf(scoped.key, textId), {
            principal: actor.value.subject.id,
            name: actor.value.login ?? actor.value.subject.id,
            role: scoped.role,
            access: scoped.access,
          })
          fields.outcome = "joined"
          return joined
        }).pipe(Effect.catchCause(unavailable(fields))))

    /** `GET /api/shapes/texts?text=<id>&<scope>`; sessions unreadable, 503 (worker/ShapeAccess.ts). */
    const shape = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const named = new URL(request.url, "http://localhost").searchParams.get("text")
        const scope = scopeOfQuery(request.url)
        const actor = yield* ShapeAccess.actor
        const scoped = scope === undefined
          ? undefined
          : yield* scopeAccess(actor, scope).pipe(Effect.provide(database), Effect.mapError(() => ShapeAccess.unavailable))
        // Losing the text while synced swaps the `where` under the device's handle: Electric answers it `409
        // must-refetch`, and the device's copy empties.
        const key = named !== null && isUuid(named) && scoped !== undefined && canView(scoped.access)
          ? scoped.key
          : NO_SCOPE
        return {
          table: TEXT_UPDATES_TABLE,
          columns: TEXT_UPDATE_COLUMNS,
          where: "scope = $1 AND text_id = $2",
          params: { "1": key, "2": named !== null && isUuid(named) ? named.toLowerCase() : NO_TEXT },
        }
      }),
      name: "text.shape",
      metric: shapes,
    })

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (path === TEXTS_SHAPE_ROUTE) return yield* shape
      const text = textPath(path)
      if (text === undefined) return HttpServerResponse.empty({ status: 404 })
      return yield* text.room ? room(text.textId) : write(text.textId)
    })
    return { fetch }
  })
