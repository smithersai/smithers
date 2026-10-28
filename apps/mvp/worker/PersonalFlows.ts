import { digestSync } from "@smthrs/crypto"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient, SqlError } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../src/features/chat/contract.ts"
import {
  FLOW_DRAFTS_TABLE,
  FLOWS_TABLE,
  MAX_FLOWS_BODY_BYTES,
  MAX_SOURCE_BYTES,
  RESERVED_NAMES,
} from "../src/features/flows-ui/contract.ts"
import {
  DraftAnswers,
  type DraftQuestion,
  DraftWrite,
  FlowName,
  SaveRequest,
  WriteRequest,
} from "../src/features/flows-ui/schema.ts"
import { placementOf, SOURCE_PATH } from "../src/features/flows-ui/source.ts"
import { type Actor, refusesPersonOnly, Sessions } from "./Actor.ts"
import { readBounded } from "./Body.ts"
import { codeOf } from "./ErrorCode.ts"
import * as ShapeAccess from "./ShapeAccess.ts"

// A person's own flows in ChatApi (decision 0014 §1 and §2, docs/features/flows.md#your-own-flows). A person's flow is
// flow source, a `Flow.make` module stored here and synced to their devices, with where its latest revision runs
// (`placement`, read from the source by `placementOf`). Only its owner reads or writes it, and anyone signed in may have
// some: running one asks their own model (ruling AUTH-8).
//
// - `GET /api/flows`: the person's live flows, newest first.
// - `GET /api/flows/source?name=<name>[&revision=<n>][&flowId=<id>]`: one flow's source at a revision (the latest
//   unless set), with its digest; with `flowId`, that flow's, deleted or not. A deleted flow's revisions stay readable
//   by revision, so a run that pinned one can still be retried.
// - `POST /api/flows/save {draftId, name, description, source, digest}`: a ready draft becomes a flow, or the next
//   revision of the flow it edits, in one transaction that also marks the draft saved. ChatApi admits only the draft's
//   own file, unchanged, whose checks all passed, under a name that is free; saving a saved draft answers what it saved.
// - `POST /api/flows/write {name, revision, description, source, digest}`: source the person wrote becomes the next
//   revision of their flow `name`, admitted only while `revision` is still its latest (`409 stale` otherwise).
// - `POST /api/flows/<id>/delete`: deletes one; its name is free again.
// - `GET /api/flow-drafts`: the person's drafts not saved yet, newest first.
// - `GET` and `POST /api/flow-drafts/<id>`: a draft round, which only `flow/new`'s steps write. A write for an older
//   round than the row's is stale, a saved draft never changes, and a deleted one is gone (`404`).
// - `POST /api/flow-drafts/<id>/delete`: deletes a draft not saved yet; a round still running can't write it back.
// - `POST /api/flow-drafts/<id>/answers {round, answers}`: the person's answers to the round's questions.
// - `GET /api/shapes/flows` and `GET /api/shapes/flow-drafts`: Electric's rows of the signed-in person, without the
//   owner's id; signed out, none.
//
// Every request is a log line `flow.route`, a span `flow.route` and a count, with ids, statuses and codes only: never a
// request, a file, a question, an answer, a description or a flow's name.

/** Requests to the flows and drafts routes, by `route` and `status`. */
export const requests = Metric.counter("smithers_flow_route_requests", {
  description: "Requests to the flows and drafts routes, by route and status",
  incremental: true,
})

/** `GET /api/shapes/flows` and `/api/shapes/flow-drafts` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_flow_shape_requests", {
  description: "GET /api/shapes/flows and /api/shapes/flow-drafts requests, by status and live",
  incremental: true,
})

/** The `flows` columns a device syncs: a live flow, without its owner's id. */
export const SYNCED_FLOW_COLUMNS = ["id", "name", "revision", "description", "placement", "created_at", "updated_at"]

/** The `flow_drafts` columns a device syncs: all of them but the author's id. */
export const SYNCED_DRAFT_COLUMNS = [
  "id",
  "scope",
  "repo_id",
  "target",
  "name",
  "request",
  "status",
  "round",
  "summary",
  "files",
  "checks",
  "questions",
  "failure",
  "flow_id",
  "created_at",
  "updated_at",
]

/** No person's id: what a signed-out shape filters on, so it holds no rows. */
const NOBODY = ""

const decodeDraftWrite = Schema.decodeUnknownEffect(Schema.fromJsonString(DraftWrite))
const decodeAnswers = Schema.decodeUnknownEffect(Schema.fromJsonString(DraftAnswers))
const decodeSave = Schema.decodeUnknownEffect(Schema.fromJsonString(SaveRequest))
const decodeWrite = Schema.decodeUnknownEffect(Schema.fromJsonString(WriteRequest))
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))
const isName = Schema.is(FlowName)

type Fields = Record<string, string | number | boolean>

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
const ok = (body: unknown) => HttpServerResponse.jsonUnsafe(body, { headers: noStore })

/** The bytes of `text` as UTF-8. */
const bytesOf = (text: string) => new TextEncoder().encode(text).length

/** A draft row as the routes read it. */
interface DraftRow {
  readonly actorId: string
  readonly status: string
  readonly round: number
  readonly request: string
  readonly name: string | null
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly checks: ReadonlyArray<{ readonly ok: boolean }>
  readonly questions: ReadonlyArray<DraftQuestion>
  readonly flowId: string | null
  readonly deleted: boolean
}

/** The draft `id`, as the routes read it, or `undefined`. */
const draftOf = (id: string, lock: "lock" | "read" = "read") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly actorId: string
      readonly status: string
      readonly round: number
      readonly request: string
      readonly name: string | null
      readonly files: unknown
      readonly checks: unknown
      readonly questions: unknown
      readonly flowId: string | null
      readonly deleted: boolean
    }>`
      SELECT actor_id AS "actorId", status, round, request, name, files, checks, questions, flow_id AS "flowId",
        deleted_at IS NOT NULL AS deleted
      FROM flow_drafts WHERE id = ${id} ${lock === "lock" ? sql`FOR UPDATE` : sql``}`
    // The driver hands jsonb columns over parsed.
    return row === undefined ? undefined : {
      ...row,
      files: row.files as DraftRow["files"],
      checks: row.checks as DraftRow["checks"],
      questions: row.questions as DraftRow["questions"],
    } satisfies DraftRow
  })

/** A draft row the caller found, as a device reads it: what the shape syncs, in camelCase. */
const draftBody = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<Record<string, unknown>>`
      SELECT id, scope, repo_id AS "repoId", target, name, request, status, round, summary, files, checks, questions,
        failure, flow_id AS "flowId", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM flow_drafts WHERE id = ${id}`
    return {
      ...row!,
      createdAt: new Date(row!.createdAt as string).toISOString(),
      updatedAt: new Date(row!.updatedAt as string).toISOString(),
    }
  })

/** Writes one round: inserts the draft, or updates the author's own when the round is the row's or newer. */
const writeDraft = (id: string, actorId: string, write: DraftWrite) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly txid: string }>`
      INSERT INTO flow_drafts AS d (id, actor_id, scope, name, request, status, round, summary, files, checks, questions,
        failure, flow_id)
      VALUES (${id}, ${actorId}, ${write.scope}, ${write.name}, ${write.request}, ${write.status}, ${write.round},
        ${write.summary}, ${JSON.stringify(write.files)}::jsonb, ${JSON.stringify(write.checks)}::jsonb,
        ${JSON.stringify(write.questions)}::jsonb, ${write.failure}, ${write.flowId})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status, round = EXCLUDED.round, summary = EXCLUDED.summary,
        files = EXCLUDED.files, checks = EXCLUDED.checks, questions = EXCLUDED.questions, failure = EXCLUDED.failure,
        updated_at = now()
      WHERE d.actor_id = EXCLUDED.actor_id AND d.round <= EXCLUDED.round AND d.status NOT IN ('saved', 'proposed')
        AND d.deleted_at IS NULL
        AND NOT (d.round = EXCLUDED.round AND d.status = EXCLUDED.status AND d.files = EXCLUDED.files
          AND d.checks = EXCLUDED.checks AND d.questions = EXCLUDED.questions
          AND d.name IS NOT DISTINCT FROM EXCLUDED.name AND d.summary IS NOT DISTINCT FROM EXCLUDED.summary
          AND d.failure IS NOT DISTINCT FROM EXCLUDED.failure)
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return row === undefined ? undefined : Number(row.txid)
  })

/** Deletes the author's draft `id` not saved yet: its transaction, or why not. */
const deleteDraft = (id: string, actorId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const draft = yield* draftOf(id)
    if (draft === undefined || draft.deleted) return { _tag: "Refused" as const, status: 404, code: "not_found" }
    if (draft.actorId !== actorId) return { _tag: "Refused" as const, status: 403, code: "forbidden" }
    const [row] = yield* sql<{ readonly txid: string }>`
      UPDATE flow_drafts SET deleted_at = now(), updated_at = now()
      WHERE id = ${id} AND actor_id = ${actorId} AND deleted_at IS NULL AND status NOT IN ('saved', 'proposed')
      RETURNING pg_current_xact_id()::xid::text AS txid`
    // Saved or proposed meanwhile, or deleted by a request that won the race.
    if (row === undefined) {
      const now = yield* draftOf(id)
      return now!.deleted
        ? { _tag: "Refused" as const, status: 404, code: "not_found" }
        : { _tag: "Refused" as const, status: 409, code: "settled" }
    }
    return { _tag: "Deleted" as const, txid: Number(row.txid) }
  })

/** The answers merged into the round's questions, by id; an answer to no question of the round is dropped. */
export const withAnswers = (
  questions: ReadonlyArray<DraftQuestion>,
  answers: DraftAnswers["answers"],
): ReadonlyArray<DraftQuestion> => {
  const given = new Map(answers.map((answer) => [answer.id, answer.value]))
  return questions.map((question) => {
    const answer = given.get(question.id)
    return answer === undefined ? question : { ...question, answer }
  })
}

/** Whether `name` is one a person's flow may take: the pattern, outside the app's names. */
export const nameAllowed = (name: string): boolean =>
  isName(name) && !(RESERVED_NAMES as ReadonlyArray<string>).includes(name)

/** Why a save can't be admitted, as the code the route answers, or `undefined` when it can. */
export const saveRefusal = (draft: DraftRow, save: SaveRequest): string | undefined => {
  if (!nameAllowed(save.name)) return "name"
  if (bytesOf(save.source) > MAX_SOURCE_BYTES) return "too_large"
  if (digestSync(save.source) !== save.digest) return "digest"
  if (draft.status !== "ready") return "not_ready"
  if (draft.checks.length === 0 || draft.checks.some((check) => !check.ok)) return "checks"
  if (draft.questions.some((question) => question.blocking && question.answer === undefined)) return "needs_you"
  const [file, ...more] = draft.files
  if (file === undefined || more.length > 0 || file.path !== SOURCE_PATH || file.text !== save.source) return "not_draft"
  if (draft.name !== save.name) return "not_draft"
  return undefined
}

/** A unique violation of the live-name index: the name is taken. */
const nameTaken = (error: unknown) =>
  SqlError.isSqlError(error) && error.reason._tag === "UniqueViolation" && error.reason.constraint === "flows_owner_name"

/**
 * Saves a ready draft as a flow, or the next revision of the flow it edits; marks the draft saved. One transaction,
 * which locks the draft first and checks the locked row again: a second save of the same draft waits for the first and
 * then finds it saved (`Existing`), so a double Save makes one revision, and a round written meanwhile is what gets
 * checked, so a save never marks a newer round saved with an older round's file (`Refused`). A flow deleted meanwhile
 * is `Gone`, before anything is written.
 */
const save = (actorId: string, request: SaveRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      // The route found the row, and a draft row is never removed: deletion only marks it.
      const draft = (yield* draftOf(request.draftId, "lock"))!
      if (draft.deleted) return { _tag: "Refused" as const, status: 404, code: "not_found" }
      if (draft.status === "saved") return { _tag: "Existing" as const, draft }
      // The request passed the route's own check, so what can refuse it now is the row that changed: a 409.
      const refused = saveRefusal(draft, request)
      if (refused !== undefined) return { _tag: "Refused" as const, status: 409, code: refused }
      let flowId: string
      let revision: number
      const placement = placementOf(request.source)
      if (draft.flowId === null) {
        flowId = crypto.randomUUID()
        revision = 1
        yield* sql`
          INSERT INTO flows (id, owner_id, name, revision, description, placement)
          VALUES (${flowId}, ${actorId}, ${request.name}, 1, ${request.description}, ${placement})`
      } else {
        const [row] = yield* sql<{ readonly revision: number }>`
          UPDATE flows SET revision = revision + 1, name = ${request.name}, description = ${request.description},
            placement = ${placement}, updated_at = now()
          WHERE id = ${draft.flowId} AND owner_id = ${actorId} AND deleted_at IS NULL
          RETURNING revision`
        if (row === undefined) return { _tag: "Gone" as const }
        flowId = draft.flowId
        revision = row.revision
      }
      yield* sql`
        INSERT INTO flow_revisions (flow_id, revision, digest, source, created_by)
        VALUES (${flowId}, ${revision}, ${request.digest}, ${request.source}, ${actorId})`
      const [written] = yield* sql<{ readonly txid: string }>`
        UPDATE flow_drafts SET status = 'saved', flow_id = ${flowId}, updated_at = now() WHERE id = ${request.draftId}
        RETURNING pg_current_xact_id()::xid::text AS txid`
      return { _tag: "Saved" as const, flowId, name: request.name, revision, txid: Number(written!.txid) }
    }))
  })

/** The flow and revision a saved draft became: what a repeated save answers. */
const savedOf = (draft: DraftRow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly flowId: string; readonly name: string; readonly revision: number }>`
      SELECT id AS "flowId", name, revision FROM flows WHERE id = ${draft.flowId}`
    return row
  })

/** Why a write can't be admitted before it reaches the database, as the code the route answers, or `undefined`. */
export const writeRefusal = (write: WriteRequest): string | undefined => {
  if (!nameAllowed(write.name)) return "name"
  if (bytesOf(write.source) > MAX_SOURCE_BYTES) return "too_large"
  if (digestSync(write.source) !== write.digest) return "digest"
  return undefined
}

/**
 * Writes the person's source as the next revision of their live flow `name`, while `revision` is still its latest:
 * `Written`, `Stale` when another revision followed it, `Missing` when they have no such flow. One transaction. A write
 * whose very bytes already are the revision after `revision` answers that revision, so a step tried again after its
 * answer was lost isn't refused stale by its own write.
 */
const writeFlow = (actorId: string, write: WriteRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const [row] = yield* sql<{ readonly id: string; readonly revision: number }>`
        UPDATE flows SET revision = revision + 1, description = ${write.description},
          placement = ${placementOf(write.source)}, updated_at = now()
        WHERE owner_id = ${actorId} AND name = ${write.name} AND deleted_at IS NULL AND revision = ${write.revision}
        RETURNING id, revision`
      if (row === undefined) {
        const [live] = yield* sql<{ readonly id: string; readonly digest: string | null }>`
          SELECT f.id, r.digest FROM flows f
          LEFT JOIN flow_revisions r ON r.flow_id = f.id AND r.revision = ${write.revision + 1}
          WHERE f.owner_id = ${actorId} AND f.name = ${write.name} AND f.deleted_at IS NULL`
        if (live === undefined) return { _tag: "Missing" as const }
        if (live.digest !== write.digest) return { _tag: "Stale" as const }
        return {
          _tag: "Written" as const,
          flowId: live.id,
          name: write.name,
          revision: write.revision + 1,
          txid: null,
        }
      }
      const [written] = yield* sql<{ readonly txid: string }>`
        INSERT INTO flow_revisions (flow_id, revision, digest, source, created_by)
        VALUES (${row.id}, ${row.revision}, ${write.digest}, ${write.source}, ${actorId})
        RETURNING pg_current_xact_id()::xid::text AS txid`
      return {
        _tag: "Written" as const,
        flowId: row.id,
        name: write.name,
        revision: row.revision,
        txid: Number(written!.txid),
      }
    }))
  })

/** The person's live flows, newest first. */
const listFlows = (actorId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{
      readonly id: string
      readonly name: string
      readonly revision: number
      readonly description: string
      readonly placement: string
    }>`
      SELECT id, name, revision, description, placement FROM flows WHERE owner_id = ${actorId} AND deleted_at IS NULL
      ORDER BY updated_at DESC, id`
  })

/** The person's drafts not saved yet, newest first. */
const listDrafts = (actorId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{
      readonly id: string
      readonly name: string | null
      readonly request: string
      readonly status: string
    }>`
      SELECT id, name, request, status FROM flow_drafts
      WHERE actor_id = ${actorId} AND deleted_at IS NULL AND status <> 'saved'
      ORDER BY updated_at DESC, id`
  })

/** One revision of the person's flow `name`: the latest live one, or `revision` of any of their flows by that name. */
const sourceOf = (actorId: string, name: string, revision: number | undefined, flowId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // A revision of the flow `flowId`, deleted or not: what a pinned run retries, even after its name was reused.
    if (flowId !== undefined) {
      const [row] = yield* sql<{ readonly flowId: string; readonly name: string; readonly revision: number; readonly digest: string; readonly source: string }>`
        SELECT f.id AS "flowId", f.name, r.revision, r.digest, r.source FROM flows f
        JOIN flow_revisions r ON r.flow_id = f.id AND r.revision = ${revision ?? sql`f.revision`}
        WHERE f.id = ${flowId} AND f.owner_id = ${actorId} AND f.name = ${name}`
      return row
    }
    const rows = revision === undefined
      ? yield* sql<{ readonly flowId: string; readonly name: string; readonly revision: number; readonly digest: string; readonly source: string }>`
          SELECT f.id AS "flowId", f.name, r.revision, r.digest, r.source FROM flows f
          JOIN flow_revisions r ON r.flow_id = f.id AND r.revision = f.revision
          WHERE f.owner_id = ${actorId} AND f.name = ${name} AND f.deleted_at IS NULL`
      : yield* sql<{ readonly flowId: string; readonly name: string; readonly revision: number; readonly digest: string; readonly source: string }>`
          SELECT f.id AS "flowId", f.name, r.revision, r.digest, r.source FROM flows f
          JOIN flow_revisions r ON r.flow_id = f.id AND r.revision = ${revision}
          WHERE f.owner_id = ${actorId} AND f.name = ${name}
          ORDER BY f.deleted_at IS NULL DESC, f.created_at DESC LIMIT 1`
    return rows[0]
  })

/** Deletes the person's flow `id`: its transaction, or `undefined` when it isn't theirs or is gone. */
const deleteFlow = (actorId: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly txid: string }>`
      UPDATE flows SET deleted_at = now(), updated_at = now()
      WHERE id = ${id} AND owner_id = ${actorId} AND deleted_at IS NULL
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return row === undefined ? undefined : Number(row.txid)
  })

/** Records the person's answers to the round's questions: its transaction, or why not. */
const answerDraft = (id: string, actorId: string, answers: DraftAnswers) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const draft = yield* draftOf(id)
    if (draft === undefined || draft.deleted) return { _tag: "Refused" as const, status: 404, code: "not_found" }
    if (draft.actorId !== actorId) return { _tag: "Refused" as const, status: 403, code: "forbidden" }
    if (draft.status === "saved" || draft.status === "proposed") {
      return { _tag: "Refused" as const, status: 409, code: "settled" }
    }
    if (draft.round !== answers.round || draft.status === "drafting") {
      return { _tag: "Refused" as const, status: 409, code: "stale_round" }
    }
    const questions = withAnswers(draft.questions, answers.answers)
    const [row] = yield* sql<{ readonly txid: string }>`
      UPDATE flow_drafts SET questions = ${JSON.stringify(questions)}::jsonb, updated_at = now()
      WHERE id = ${id} AND round = ${answers.round} AND questions IS DISTINCT FROM ${JSON.stringify(questions)}::jsonb
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return { _tag: "Written" as const, txid: row === undefined ? null : Number(row.txid) }
  })

/** Reads at most `MAX_FLOWS_BODY_BYTES` and decodes it with `decode`: the value, or the refusal to answer. */
const body = <A>(
  request: HttpServerRequest.HttpServerRequest,
  fields: Fields,
  decode: (text: string) => Effect.Effect<A, unknown>,
): Effect.Effect<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly response: HttpServerResponse.HttpServerResponse }
> =>
  readBounded(request, MAX_FLOWS_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
    Effect.flatMap((text) => Effect.option(decode(text))),
    Effect.map((decoded) =>
      Option.isSome(decoded)
        ? { ok: true as const, value: decoded.value }
        : { ok: false as const, response: refusal(400, "invalid") }
    ),
    Effect.catchTag("BodyRefused", (refused) =>
      Effect.succeed({
        ok: false as const,
        response: refused.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid"),
      })),
  )

/**
 * Reads Electric's connection (`ShapeProxy.config`) and returns the flows routes: `flows(rest)` for `/api/flows` and
 * `/api/flows/<rest>`, `drafts(rest)` for `/api/flow-drafts/<rest>`, and `flowsShape` and `draftsShape`. `database`
 * opens a Postgres client for the scope of each request.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })

    /** Runs `handle` for an actor who may ask, recording the request as `route`. */
    const routed = (
      route: string,
      handle: (
        request: HttpServerRequest.HttpServerRequest,
        actor: Actor,
        fields: Fields,
      ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, SqlClient.SqlClient>,
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Fields = { route }
        const response = yield* Effect.gen(function* () {
          const actor = yield* (yield* Sessions).resolve
          // Anyone signed in: a person's own flows are theirs and ask their own model (ruling AUTH-8); none runs on a
          // machine yet (docs/features/flows.md#your-own-flows).
          if (Option.isNone(actor)) return refusal(401, "authentication")
          return yield* handle(request, actor.value, fields).pipe(Effect.provide(database))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refusal(503, "unavailable")
            })
          ),
        )
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(requests, { route, status: String(response.status) }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "flow.route",
        ).pipe(Effect.annotateLogs(fields))
        return response
      }).pipe(Effect.withSpan("flow.route", { kind: "server", attributes: { "smithers.flow.route": route } }))

    const methodNot = (allow: string) => HttpServerResponse.empty({ status: 405, headers: { allow } })

    /** `GET /api/flows`. */
    const list = routed("list", (request, actor) =>
      Effect.gen(function* () {
        if (request.method !== "GET") return methodNot("GET")
        return ok({ flows: yield* listFlows(actor.subject.id) })
      }))

    /** `GET /api/flows/source?name=<name>[&revision=<n>]`. */
    const source = routed("source", (request, actor, fields) =>
      Effect.gen(function* () {
        if (request.method !== "GET") return methodNot("GET")
        const query = new URL(request.url, "http://flows").searchParams
        const name = query.get("name") ?? ""
        const revisionText = query.get("revision")
        const revision = revisionText === null ? undefined : Number(revisionText)
        const flowId = query.get("flowId") ?? undefined
        if (
          !isName(name) || (revision !== undefined && !(Number.isSafeInteger(revision) && revision >= 1)) ||
          (flowId !== undefined && !isUuid(flowId))
        ) {
          return refusal(400, "invalid")
        }
        if (revision !== undefined) fields.revision = revision
        const found = yield* sourceOf(actor.subject.id, name, revision, flowId?.toLowerCase())
        if (found === undefined) return refusal(404, "not_found")
        fields.flowId = found.flowId
        return ok(found)
      }))

    /** `POST /api/flows/save`. */
    const saveRoute = routed("save", (request, actor, fields) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return methodNot("POST")
        const read = yield* body(request, fields, decodeSave)
        if (!read.ok) return read.response
        const saving = read.value
        fields.draftId = saving.draftId
        const draft = yield* draftOf(saving.draftId.toLowerCase())
        if (draft === undefined || draft.deleted) return refusal(404, "not_found")
        if (draft.actorId !== actor.subject.id) return refusal(403, "forbidden")
        if (draft.status === "saved") {
          const saved = yield* savedOf(draft)
          fields.existing = true
          return ok({ ...saved, txid: null })
        }
        const refused = saveRefusal(draft, saving)
        if (refused !== undefined) {
          fields.code = refused
          return refusal(refused === "too_large" ? 413 : 409, refused)
        }
        const saved = yield* save(actor.subject.id, { ...saving, draftId: saving.draftId.toLowerCase() }).pipe(
          Effect.catchIf(nameTaken, () => Effect.succeed({ _tag: "Taken" as const })),
        )
        if (saved._tag === "Taken") {
          fields.code = "name_taken"
          return refusal(409, "name_taken")
        }
        if (saved._tag === "Gone") {
          fields.code = "gone"
          return refusal(409, "gone")
        }
        if (saved._tag === "Refused") {
          // The draft changed between the first read and the lock: what it is now is refused.
          fields.code = saved.code
          return refusal(saved.status, saved.code)
        }
        if (saved._tag === "Existing") {
          // Another save of this draft got there first.
          fields.existing = true
          return ok({ ...(yield* savedOf(saved.draft)), txid: null })
        }
        fields.flowId = saved.flowId
        fields.revision = saved.revision
        return ok({ flowId: saved.flowId, name: saved.name, revision: saved.revision, txid: saved.txid })
      }))

    /** `POST /api/flows/write`. */
    const writeRoute = routed("write", (request, actor, fields) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return methodNot("POST")
        const read = yield* body(request, fields, decodeWrite)
        if (!read.ok) return read.response
        const write = read.value
        fields.revision = write.revision
        fields.placement = placementOf(write.source)
        const refused = writeRefusal(write)
        if (refused !== undefined) {
          fields.code = refused
          return refusal(refused === "too_large" ? 413 : 409, refused)
        }
        const written = yield* writeFlow(actor.subject.id, write)
        if (written._tag === "Missing") return refusal(404, "not_found")
        if (written._tag === "Stale") {
          fields.code = "stale"
          return refusal(409, "stale")
        }
        fields.flowId = written.flowId
        return ok({ flowId: written.flowId, name: written.name, revision: written.revision, txid: written.txid })
      }))

    /** `POST /api/flows/<id>/delete`. */
    const remove = (id: string) =>
      routed("delete", (request, actor, fields) =>
        Effect.gen(function* () {
          if (request.method !== "POST") return methodNot("POST")
          fields.flowId = id
          const txid = yield* deleteFlow(actor.subject.id, id)
          return txid === undefined ? refusal(404, "not_found") : ok({ txid })
        }))

    /** `/api/flows` and `/api/flows/<rest>`. */
    const flows = (rest: string) => {
      if (rest === "") return list
      if (rest === "source") return source
      if (rest === "save") return saveRoute
      if (rest === "write") return writeRoute
      const [id = "", tail, ...more] = rest.split("/")
      if (tail === "delete" && more.length === 0 && isUuid(id)) return remove(id.toLowerCase())
      return Effect.succeed(refusal(404, "not_found"))
    }

    /** `GET` and `POST /api/flow-drafts/<id>`. */
    const draft = (id: string) =>
      routed("draft", (request, actor, fields) =>
        Effect.gen(function* () {
          fields.draftId = id
          if (request.method === "GET") {
            const row = yield* draftOf(id)
            if (row === undefined || row.deleted) return refusal(404, "not_found")
            if (row.actorId !== actor.subject.id) return refusal(403, "forbidden")
            return ok(yield* draftBody(id))
          }
          if (request.method !== "POST") return methodNot("GET, POST")
          const read = yield* body(request, fields, decodeDraftWrite)
          if (!read.ok) return read.response
          const write = read.value
          fields.round = write.round
          fields.outcome = write.status
          if (write.files.reduce((sum, file) => sum + bytesOf(file.text), 0) > MAX_SOURCE_BYTES) {
            return refusal(413, "too_large")
          }
          const txid = yield* writeDraft(id, actor.subject.id, write)
          if (txid !== undefined) return ok({ txid })
          const row = yield* draftOf(id)
          if (row!.actorId !== actor.subject.id) return refusal(403, "forbidden")
          // Deleted: a round still running on a device can't bring it back.
          if (row!.deleted) return refusal(404, "not_found")
          if (row!.status === "saved" || row!.status === "proposed") return refusal(409, "settled")
          if (row!.round > write.round) return refusal(409, "stale_round")
          fields.existing = true
          return ok({ txid: null })
        }))

    /** `POST /api/flow-drafts/<id>/answers`. */
    const answers = (id: string) =>
      routed("answers", (request, actor, fields) =>
        Effect.gen(function* () {
          fields.draftId = id
          if (request.method !== "POST") return methodNot("POST")
          // Only the person answers what the drafting agent asked (decision 0017 slice 0).
          if (yield* refusesPersonOnly(actor, "flow/answer")) return refusal(403, "person_only")
          const read = yield* body(request, fields, decodeAnswers)
          if (!read.ok) return read.response
          fields.round = read.value.round
          const answered = yield* answerDraft(id, actor.subject.id, read.value)
          if (answered._tag === "Refused") return refusal(answered.status, answered.code)
          return ok({ txid: answered.txid })
        }))

    /** `POST /api/flow-drafts/<id>/delete`. */
    const removeDraft = (id: string) =>
      routed("draft_delete", (request, actor, fields) =>
        Effect.gen(function* () {
          fields.draftId = id
          if (request.method !== "POST") return methodNot("POST")
          const deleted = yield* deleteDraft(id, actor.subject.id)
          if (deleted._tag === "Refused") {
            fields.code = deleted.code
            return refusal(deleted.status, deleted.code)
          }
          return ok({ txid: deleted.txid })
        }))

    /** `GET /api/flow-drafts`. */
    const draftList = routed("draft_list", (request, actor) =>
      Effect.gen(function* () {
        if (request.method !== "GET") return methodNot("GET")
        return ok({ drafts: yield* listDrafts(actor.subject.id) })
      }))

    /** `/api/flow-drafts` and `/api/flow-drafts/<rest>`. */
    const drafts = (rest: string) => {
      if (rest === "") return draftList
      const [id = "", tail, ...more] = rest.split("/")
      if (!isUuid(id) || more.length > 0) return Effect.succeed(refusal(404, "not_found"))
      if (tail === undefined) return draft(id.toLowerCase())
      if (tail === "answers") return answers(id.toLowerCase())
      if (tail === "delete") return removeDraft(id.toLowerCase())
      return Effect.succeed(refusal(404, "not_found"))
    }

    /** A person's rows of `table`, `where` naming its owner as `$1`; signed out, none; sessions unreadable, 503. */
    const shapeOf = (table: string, where: string, columns: ReadonlyArray<string>, name: string) =>
      ShapeProxy.make({
        ...connection,
        shape: Effect.map(ShapeAccess.actor, (actor) => ({
          table,
          where,
          params: { "1": Option.match(actor, { onNone: () => NOBODY, onSome: (actor) => actor.subject.id }) },
          columns: [...columns],
        })),
        name,
        metric: shapes,
      })

    const flowsShape = shapeOf(FLOWS_TABLE, "owner_id = $1 AND deleted_at IS NULL", SYNCED_FLOW_COLUMNS, "flow.shape")
    const draftsShape = shapeOf(FLOW_DRAFTS_TABLE, "actor_id = $1 AND deleted_at IS NULL", SYNCED_DRAFT_COLUMNS, "flow.drafts.shape")

    return { flows, drafts, flowsShape, draftsShape }
  })
