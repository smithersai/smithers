import { digestSync } from "@smthrs/crypto"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Core } from "@smthrs/integrations"
import { Cause, Clock, Config, Effect, type Layer, Metric, Option, Schema } from "effect"
import * as SchemaIssue from "effect/SchemaIssue"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import {
  ANSWERS_MAX,
  FEED_DOCUMENT_COLUMNS,
  FEED_DOCUMENTS_TABLE,
  FEED_KEYS_VARIABLE,
  feedDocumentId,
  feedRepo,
  FEEDS_SHAPE_ROUTE,
  isFeedName,
  MAX_ANSWER_BODY_BYTES,
  MAX_FEED_DOCUMENT_BYTES,
  MAX_FEED_DOCUMENTS,
  MAX_FEED_REQUEST_BYTES,
  parseFeedRepo,
  parseFeedRoute,
  type Refusal,
} from "../../src/features/feeds/contract.ts"
import { AnswerRequest, type FeedAnswer, IngestRequest } from "../../src/features/feeds/schema.ts"
import { type Actor, refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as ShapeAccess from "../ShapeAccess.ts"

// Repository feeds' routes (decision 0126, docs/features/feeds.md):
//
// - `POST /api/repos/<owner>/<name>/feeds`, bearer feed key: an outside collector sets or deletes a repository's
//   documents. A body equal to the stored one is left alone, so Electric sends nothing.
// - `GET /api/repos/<owner>/<name>/feeds/answers?after=<seq>`, bearer feed key: the answers after the cursor, oldest
//   first. Reading never deletes.
// - `POST /api/repos/<owner>/<name>/feeds/answers`: a Maintainer or Admin of that repository (`RepoRoles`), in person,
//   records an answer, keyed by its id.
// - `GET /api/shapes/feeds?repo=<owner>/<name>[&name=<document>]`: the index (names without `/`), or one document.
//   `public` documents to everyone, signed out included; `maintainers` ones only to a Maintainer or Admin in person.
//
// `FEED_KEYS` holds each repository's key's SHA-256, never a key. No log line, span or metric carries a body, a
// document's name, an answer's words, a login or a key: only counts, codes and durations.

/** Feed requests, by `op` (`ingest`, `answer`, `answers`) and `outcome`. */
export const requests = Metric.counter("smithers_feed_requests", {
  description: "Requests to a repository's feeds routes, by op and outcome",
  incremental: true,
})

/** `GET /api/shapes/feeds` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_feed_shape_requests", {
  description: "GET /api/shapes/feeds requests, by status and live",
  incremental: true,
})

/** Whom a feeds shape request was served as, by `audience` (`public`, `maintainers`) and `single` (one document). */
export const audiences = Metric.counter("smithers_feed_shape_audiences", {
  description: "GET /api/shapes/feeds requests, by the audience they were served as and whether they named a document",
  incremental: true,
})

/** Whether a path is one of the feeds' routes. */
export const handles = (path: string): boolean => path === FEEDS_SHAPE_ROUTE || parseFeedRoute(path) !== undefined

/** Each repository's feed key's SHA-256, in lowercase hex, by its `owner/name`. */
export type FeedKeys = ReadonlyMap<string, string>

const KEY_PAIR = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)=([0-9A-Fa-f]{64})$/

/**
 * `FEED_KEYS` (`owner/name=<sha256 hex>,...`) as each repository's digest; `None` when unset or blank, which turns the
 * collector's routes off. A malformed list fails the deployment's config, never a request.
 */
export const feedKeys = Effect.gen(function* () {
  const text = yield* Config.option(Config.String(FEED_KEYS_VARIABLE))
  if (Option.isNone(text) || text.value.trim() === "") return Option.none<FeedKeys>()
  const keys = new Map<string, string>()
  for (const pair of text.value.split(",")) {
    const match = KEY_PAIR.exec(pair.trim())
    const repo = match === null ? undefined : parseFeedRepo(match[1]!)
    if (match === null || repo === undefined) {
      return yield* Effect.fail(new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({ message: `${FEED_KEYS_VARIABLE} is not a comma-separated list of owner/name=<sha256 hex>` }),
        ),
      ))
    }
    keys.set(repo, match[2]!.toLowerCase())
  }
  return Option.some<FeedKeys>(keys)
})

const encoder = new TextEncoder()

/** Whether `presented`'s SHA-256 is `digest`, compared in constant time. */
export const keyMatches = (presented: string, digest: string): boolean =>
  Core.Signature.constantTimeEqual(encoder.encode(digestSync(presented)), encoder.encode(digest))

/** Whether `actor` may read a repository's `maintainers` documents and answer for it: Maintainer or Admin, in person. */
export const mayMaintain = (actor: Actor, role: Actor["role"]): boolean =>
  actor.act === undefined && (role === "maintainer" || role === "admin")

/** An `after` cursor: 0 when absent, else a whole number. */
export const afterOf = (raw: string | null): number | undefined => {
  if (raw === null) return 0
  return /^\d{1,15}$/.test(raw) ? Number(raw) : undefined
}

/** Why a write's documents can't be stored: a name outside the grammar, or a body too large or holding a NUL. */
export const checkSet = (set: IngestRequest["set"]): Refusal | undefined => {
  const entries = Object.entries(set)
  if (entries.length > MAX_FEED_DOCUMENTS) return "too_large"
  for (const [name, document] of entries) {
    if (!isFeedName(name)) return "invalid_name"
    if (document === null) continue
    const json = JSON.stringify(document.body)
    if (encoder.encode(json).byteLength > MAX_FEED_DOCUMENT_BYTES) return "too_large"
    // Postgres' jsonb can't store a NUL character: refused, so the collector doesn't retry a write that can't land.
    if (json.includes("\\u0000")) return "invalid"
  }
  return undefined
}

/**
 * Sets and deletes `repo`'s documents in one transaction, against the `SqlClient` in context. A document whose body and
 * visibility equal the stored ones is left alone, so Electric sends nothing for it.
 */
export const ingest = (repo: string, set: IngestRequest["set"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const upserts = Object.entries(set).flatMap(([name, document]) =>
      document === null ? [] : [{ id: feedDocumentId(repo, name), name, visibility: document.visibility, body: document.body }]
    )
    const deletes = Object.entries(set).flatMap(([name, document]) => (document === null ? [name] : []))
    return yield* sql.withTransaction(Effect.gen(function* () {
      const written = upserts.length === 0 ? [] : yield* sql<{ readonly id: string }>`
        INSERT INTO feed_documents (id, repo, name, visibility, body, updated_at)
        SELECT input.id, ${repo}, input.name, input.visibility, COALESCE(input.body, 'null'::jsonb), now()
        FROM jsonb_to_recordset(${JSON.stringify(upserts)}::jsonb) AS input(id text, name text, visibility text, body jsonb)
        ON CONFLICT (id) DO UPDATE SET visibility = EXCLUDED.visibility, body = EXCLUDED.body, updated_at = now()
        WHERE feed_documents.body IS DISTINCT FROM EXCLUDED.body
          OR feed_documents.visibility IS DISTINCT FROM EXCLUDED.visibility
        RETURNING id`
      const deleted = deletes.length === 0 ? [] : yield* sql<{ readonly id: string }>`
        DELETE FROM feed_documents
        WHERE repo = ${repo} AND name IN (SELECT jsonb_array_elements_text(${JSON.stringify(deletes)}::jsonb))
        RETURNING id`
      return { written: written.length, unchanged: upserts.length - written.length, deleted: deleted.length }
    }))
  })

/** `repo`'s answers after `after`, oldest first, at most `ANSWERS_MAX`, against the `SqlClient` in context. */
export const answersAfter = (repo: string, after: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly seq: string } & Omit<FeedAnswer, "seq">>`
      SELECT seq::text AS seq, id::text AS id, item, choice, text, login,
        to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
      FROM feed_answers WHERE repo = ${repo} AND feed_answers.seq > ${after} ORDER BY feed_answers.seq LIMIT ${ANSWERS_MAX}`.pipe(
      Effect.map((rows) => rows.map((row): FeedAnswer => ({ ...row, seq: Number(row.seq) }))),
    ))

/**
 * Records `answer` on `repo` as `actor`'s, against the `SqlClient` in context, unless its id is taken. Answers its
 * `seq`: the one it had when `actor` sent it already, `"conflict"` when someone else did.
 */
export const record = (repo: string, answer: AnswerRequest, actor: Actor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const person = actor.subject.id
    const written = yield* sql<{ readonly seq: string }>`
      INSERT INTO feed_answers (id, repo, item, choice, text, person_id, login)
      VALUES (${answer.id}, ${repo}, ${answer.item}, ${answer.choice ?? null}, ${answer.text ?? null}, ${person},
        ${actor.login ?? null})
      ON CONFLICT (id) DO NOTHING
      RETURNING seq::text AS seq`
    if (written[0] !== undefined) return Number(written[0].seq)
    const [held] = yield* sql<{ readonly seq: string; readonly mine: boolean }>`
      SELECT seq::text AS seq, person_id = ${person} AND repo = ${repo} AS mine FROM feed_answers WHERE id = ${answer.id}`
    return held!.mine ? Number(held!.seq) : "conflict" as const
  })

const decodeIngest = Schema.decodeUnknownEffect(Schema.fromJsonString(IngestRequest))
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(AnswerRequest))

/** What a shape filters on when its `repo` or `name` isn't one: no repository, so it holds no rows. */
const NO_REPO = "-"

const noStore = { "cache-control": "no-store" }

type Fields = Record<string, string | number | boolean>

/**
 * The feeds' routes over `database`. Who is asking comes from `Sessions`, their role on the repository from `roles`,
 * and the collector's keys from `FEED_KEYS`, read here, while the program is built.
 */
export const make = <E, R, X>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  roles: RepoRoles.RepoRoles<X>,
) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    const keys = yield* feedKeys

    /** Whether `actor` is a Maintainer or Admin of `repo` in person; any role `roles` can't give now is no. */
    const maintains = (actor: Actor, repo: string) =>
      actor.act !== undefined ? Effect.succeed(false) : roles.resolve(actor, repositoryOf(repo)).pipe(
        Effect.map((resolved) => mayMaintain(actor, resolved.role)),
        Effect.orElseSucceed(() => false),
      )

    /** `GET /api/shapes/feeds?repo=<owner>/<name>[&name=<document>]`. */
    const shape = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const query = new URL(request.url, "http://localhost").searchParams
        const named = query.get("name")
        const repo = parseFeedRepo(query.get("repo") ?? "")
        const valid = repo !== undefined && (named === null || isFeedName(named))
        const actor = yield* ShapeAccess.actor
        // The role is decided once per request, failing closed to the public documents.
        const audience = valid && Option.isSome(actor) && (yield* maintains(actor.value, repo))
          ? "maintainers"
          : "public"
        yield* Metric.update(Metric.withAttributes(audiences, { audience, single: String(named !== null) }), 1)
        yield* Effect.annotateCurrentSpan({ "feed.audience": audience, "feed.single": named !== null })
        const visible = audience === "maintainers" ? "" : " AND visibility = 'public'"
        const params: Record<string, string> = { "1": valid ? repo : NO_REPO }
        if (named !== null) params["2"] = named
        return {
          table: FEED_DOCUMENTS_TABLE,
          where: named === null ? `repo = $1 AND name NOT LIKE '%/%'${visible}` : `repo = $1 AND name = $2${visible}`,
          params,
          columns: [...FEED_DOCUMENT_COLUMNS],
        }
      }),
      name: "feed.shape",
      metric: shapes,
    })

    /** The three routes under `/api/repos/<owner>/<name>/feeds`. */
    const route = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const target = parseFeedRoute(request.url.split("?")[0]!)!
      const repo = feedRepo(target.owner, target.name)
      const op = target.route === "documents" ? "ingest" : request.method === "GET" ? "answers" : "answer"
      const fields: Fields = { op, repoId: repo }
      const refuse = (status: number, code: Refusal) => {
        fields.code = code
        return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
      }
      /** Whether the request carries `repo`'s feed key: `undefined` when the collector's routes are off. */
      const keyed = () => {
        if (Option.isNone(keys)) return undefined
        const digest = keys.value.get(repo)
        const header = request.headers["authorization"]
        const presented = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length).trim() : ""
        return digest !== undefined && presented !== "" && keyMatches(presented, digest)
      }
      const response = yield* Effect.gen(function* () {
        const allowed = target.route === "documents" ? "POST" : "GET, POST"
        if (request.method !== "POST" && !(target.route === "answers" && request.method === "GET")) {
          return HttpServerResponse.empty({ status: 405, headers: { allow: allowed, ...noStore } })
        }
        if (op === "ingest") {
          const holds = keyed()
          if (holds === undefined) return refuse(503, "off")
          if (!holds) return refuse(401, "authentication")
          const body = yield* readBounded(request, MAX_FEED_REQUEST_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
            Effect.result,
          )
          if (body._tag === "Failure") {
            return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
          }
          // A decoding failure would quote the body: it is dropped whole.
          const decoded = yield* decodeIngest(body.success).pipe(Effect.option)
          if (Option.isNone(decoded)) return refuse(400, "invalid")
          const refused = checkSet(decoded.value.set)
          fields.documents = Object.keys(decoded.value.set).length
          if (refused !== undefined) return refuse(refused === "too_large" ? 413 : 400, refused)
          const done = yield* ingest(repo, decoded.value.set).pipe(Effect.provide(database))
          Object.assign(fields, done, { outcome: "ingested" })
          return HttpServerResponse.jsonUnsafe(done, { status: 200, headers: noStore })
        }
        if (op === "answers") {
          const holds = keyed()
          if (holds === undefined) return refuse(503, "off")
          if (!holds) return refuse(401, "authentication")
          const after = afterOf(new URL(request.url, "http://chat.invalid").searchParams.get("after"))
          if (after === undefined) return refuse(400, "invalid")
          const answers = yield* answersAfter(repo, after).pipe(Effect.provide(database))
          const next = answers.at(-1)?.seq ?? after
          Object.assign(fields, { outcome: "listed", count: answers.length })
          return HttpServerResponse.jsonUnsafe({ answers, next }, { status: 200, headers: noStore })
        }
        const actor = yield* (yield* Sessions).resolve
        if (Option.isNone(actor)) return refuse(401, "authentication")
        // An answer is the person's own (decision 0126 §6): anyone acting for them is refused.
        if (yield* refusesPersonOnly(actor.value, "feed/answer")) return refuse(403, "person_only")
        const resolved = yield* roles.resolve(actor.value, repositoryOf(repo)).pipe(Effect.result)
        if (resolved._tag === "Failure") {
          fields.roleCode = resolved.failure.code
          if (!RepoRoles.CANT_ACT.has(resolved.failure.code)) return refuse(503, "unavailable")
        }
        if (resolved._tag === "Failure" || !mayMaintain(actor.value, resolved.success.role)) {
          return refuse(403, "forbidden")
        }
        const body = yield* readBounded(request, MAX_ANSWER_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
          Effect.result,
        )
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
        }
        const decoded = yield* decodeAnswer(body.success).pipe(Effect.option)
        if (Option.isNone(decoded)) return refuse(400, "invalid")
        const answer = decoded.value
        const words = [answer.item, answer.choice ?? "", answer.text ?? ""]
        const empty = (answer.choice ?? null) === null && (answer.text ?? null) === null
        if (empty || words.some((word) => word.includes("\u0000"))) {
          return refuse(400, "invalid")
        }
        fields.answerId = answer.id
        const seq = yield* record(repo, answer, actor.value).pipe(Effect.provide(database))
        if (seq === "conflict") return refuse(409, "conflict")
        fields.outcome = "recorded"
        return HttpServerResponse.jsonUnsafe({ id: answer.id, seq }, { status: 200, headers: noStore })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(Cause.squash(cause))
            return refuse(503, "unavailable")
          })
        ),
      )
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      const outcome = String(fields.outcome ?? fields.code ?? "refused")
      const message = op === "ingest" ? "feed.ingest" : op === "answers" ? "feed.answers" : "feed.answer"
      yield* Metric.update(Metric.withAttributes(requests, { op, outcome }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, op, outcome })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(message)
        .pipe(Effect.annotateLogs({ ...fields, outcome }))
      return response
    })

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (path === FEEDS_SHAPE_ROUTE) return yield* shape
      const target = parseFeedRoute(path)!
      const span = target.route === "documents" ? "feed.ingest" : request.method === "GET" ? "feed.answers" : "feed.answer"
      return yield* route.pipe(Effect.withSpan(span, { kind: "server" }))
    })

    return { fetch }
  })
