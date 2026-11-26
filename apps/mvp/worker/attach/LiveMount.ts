import { Cause, Clock, Context, Effect, type Layer, Metric, Option, Result, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { isBranchName } from "../../src/features/branch/contract.ts"
import {
  ATTACH_APPROVALS_ROUTE,
  ATTACH_CAPABILITIES,
  ATTACH_CLAIMS_ROUTE,
  ATTACH_CONSENT_ROUTE,
  ATTACH_INTENTS_ROUTE,
  ATTACH_MAX_ANSWER_LENGTH,
  ATTACH_MCP_ROUTE,
  attachMcpRoute,
  ATTACH_READ_LIMIT,
  ATTACH_REVOCATIONS_ROUTE,
  ATTACH_TOKENS_ROUTE,
  MCP_MAX_REQUEST_BYTES,
} from "../../src/features/mcp/contract.ts"
import { isRepository, repoId } from "../../src/features/repo/contract.ts"
import { type Actor, Sessions } from "../Actor.ts"
import { codeOf } from "../ErrorCode.ts"
import * as SessionStore from "../SessionStore.ts"
import { askingOf, branchAccess, canView } from "../branch/Access.vibe"
import {
  ATTACH_LIMITS,
  bearerHash,
  hashCredential,
  makeAttach,
  normalizeReference,
  REFUSAL_STATUS,
  type Attach,
  type AttachRefusal,
  type AttachState,
  type Target,
} from "./Attach.ts"
import * as MessagesShardBridge from "../chat/MessagesShardBridge.ts"
import { defineTool, makeMcpRoute, readBody, targetOf } from "./McpRoute.ts"

const Uuid = Schema.String.check(Schema.isUUID())
const postgresText = Schema.makeFilter((value: string) => !value.includes("\0") && value.isWellFormed())
const shortString = Schema.String.check(Schema.isBetweenLength(1, 256), postgresText)
const Repo = Schema.String.check(Schema.makeFilter((value) => {
  const [owner, name, extra] = value.split("/")
  return owner !== undefined && name !== undefined && extra === undefined && isRepository(owner, name)
}))
const Branch = Schema.String.check(Schema.makeFilter(isBranchName))
const routes = {
  [ATTACH_INTENTS_ROUTE]: Schema.Struct({
    repo: Repo,
    branch: Branch,
    conversation: Uuid,
    ceiling: Schema.Array(Schema.Literals(ATTACH_CAPABILITIES)).check(Schema.isMaxLength(ATTACH_CAPABILITIES.length)),
  }),
  [ATTACH_CLAIMS_ROUTE]: Schema.Struct({ reference: shortString, client: shortString, challenge: shortString }),
  [ATTACH_CONSENT_ROUTE]: Schema.Struct({ reference: shortString }),
  [ATTACH_APPROVALS_ROUTE]: Schema.Struct({ claim: shortString, pairing: Schema.String.check(Schema.isMaxLength(32)) }),
  [ATTACH_TOKENS_ROUTE]: Schema.Struct({ claim: shortString, code: shortString, verifier: shortString }),
  [ATTACH_REVOCATIONS_ROUTE]: Schema.Struct({ grant: shortString }),
}
type AttachPath = keyof typeof routes
const canonicalPath = (path: string) => {
  switch (path) {
    case "/api/attach/claim": return ATTACH_CLAIMS_ROUTE
    case "/api/attach/redeem": return ATTACH_TOKENS_ROUTE
    default: return path
  }
}
const isAttachPath = (path: string): path is AttachPath => Object.hasOwn(routes, path)
const isMcpPath = (path: string) => path.startsWith(ATTACH_MCP_ROUTE + "/")

export const handles = (path: string) => isAttachPath(canonicalPath(path)) || isMcpPath(path)

/** The permission comes from the real branch and its repository, under the session that issued the grant. */
const permissions = (actor: Actor, target: Target) => Effect.gen(function* () {
  if (actor.session !== undefined) {
    const live = yield* SessionStore.authority(actor.session, actor.alias ?? null, actor.cookieKey)
    if (Option.isNone(live) || live.value.personId !== actor.subject.id) return undefined
  }
  const [owner, name] = target.repo.split("/")
  if (owner === undefined || name === undefined) return undefined
  const found = yield* branchAccess(Option.some(actor), target.conversation, "conversation")
  if (found === undefined || found.repoId !== repoId(owner, name) || found.name !== target.branch || !canView(found.access)) {
    return undefined
  }
  return askingOf(found) === "ask" ? ATTACH_CAPABILITIES : [ATTACH_CAPABILITIES[0]]
})

const conversationRead = defineTool({
  name: "conversation_read",
  description: "Read the recent messages in this conversation.",
  capability: "conversation:read",
  policy: "agent",
  input: Schema.Struct({ conversation: Schema.optional(Uuid) }),
  authorize: (grant, args) => args.conversation === undefined || args.conversation === grant.conversation,
  call: (grant) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const messages = yield* sql`
      SELECT id, role, text, status, "questionId", parts, source, data FROM (
        SELECT id, role, text, status, question_id AS "questionId", parts, position,
          CASE WHEN asked_by = ${grant.person} THEN source END AS source,
          CASE WHEN asked_by = ${grant.person} THEN data END AS data
        FROM messages
        WHERE conversation_id = ${grant.conversation}
        ORDER BY position DESC
        LIMIT ${ATTACH_READ_LIMIT}
      ) recent ORDER BY position`
    return { messages }
  }),
})

/**
 * The answers one request's tools recorded inside its transaction. They reach the conversation's shard only after
 * that transaction commits (`serveMcp`): an answer Postgres rolled back is never one the shard holds.
 */
class RecordedAnswers extends Context.Service<
  RecordedAnswers,
  { readonly record: (answer: MessagesShardBridge.Answered) => void }
>()("@smthrs/mvp/attach/RecordedAnswers") {}

const conversationRespond = defineTool({
  name: "conversation_respond",
  description: "Answer a question the person who attached you asked in this conversation.",
  capability: "conversation:write",
  policy: "agent",
  input: Schema.Struct({
    questionId: Uuid,
    text: Schema.Trim.check(Schema.isBetweenLength(1, ATTACH_MAX_ANSWER_LENGTH), postgresText),
  }),
  authorize: (grant, { questionId }) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [question] = yield* sql`
      SELECT id FROM messages
      WHERE id = ${questionId} AND conversation_id = ${grant.conversation}
        AND role = 'user' AND asked_by = ${grant.person}`
    return question !== undefined
  }),
  call: (grant, { questionId, text }) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [answer] = yield* sql<{ readonly id: string }>`
      UPDATE messages AS a SET text = ${text}, status = 'done', updated_at = now()
      FROM messages AS q
      WHERE q.id = ${questionId} AND q.conversation_id = ${grant.conversation}
        AND q.role = 'user' AND q.asked_by = ${grant.person}
        AND a.role = 'assistant' AND a.conversation_id = q.conversation_id AND a.question_id = q.id
        AND a.status = 'streaming'
      RETURNING a.id`
    const [prior] = answer !== undefined ? [answer] : yield* sql<{ readonly id: string }>`
      SELECT id FROM messages
      WHERE question_id = ${questionId} AND conversation_id = ${grant.conversation}
        AND role = 'assistant' AND status = 'done' AND text = ${text}`
    if (prior === undefined) return { answered: false }
    // The same answer and its completion, for the conversation's shard (decision 0170, slice 4c): when it was just
    // written, and when this is the same answer given again. Only recorded here, inside the transaction that holds
    // the grant's lock and the answer's row: it is sent once that transaction has committed.
    ;(yield* RecordedAnswers).record({ conversationId: grant.conversation, questionId, answerId: prior.id, text })
    return { answered: true, answerId: prior.id }
  }),
})

const tools = [conversationRead, conversationRespond]
type LiveAttach = Attach<
  Effect.Error<ReturnType<typeof permissions>>,
  Effect.Services<ReturnType<typeof permissions>>
>

interface AttachmentRow {
  readonly reference: string
  readonly grant_id: string | null
  readonly state: AttachState
}

type Lookup = "reference" | "claim_id" | "code_hash" | "grant_id"

const capacityLock = (sql: SqlClient.SqlClient, origin: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${"attach:capacity:" + origin}, 0))`

/** Mutate one lifecycle row. A code becomes a token in place, so revocation cannot race the handoff. */
const changeAttachment = <A, E, R>(
  origin: string, column: Lookup, key: string, use: (attach: LiveAttach) => Effect.Effect<Result.Result<A, AttachRefusal>, E, R>,
) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function* () {
    if (column === "claim_id") yield* capacityLock(sql, origin)
    const [row] = yield* sql<AttachmentRow>`
      SELECT reference, grant_id, state FROM attach_grants WHERE origin = ${origin} AND ${sql(column)} = ${key}
        AND (${column !== "reference"} OR token_hash IS NULL) FOR UPDATE`
    const attach = makeAttach({ hostOrigin: origin, permissions, state: row?.state })
    if (row === undefined) return yield* use(attach)
    const initial = JSON.stringify(attach.snapshot())
    const outcome = yield* use(attach)
    const state = attach.snapshot()
    const snapshot = JSON.stringify(state)
    if (snapshot === initial) return outcome
    const intent = state.intents[0]?.[1]
    const code = state.codes[0]
    const token = state.tokens[0]
    const revocation = state.revoked[0]
    const issued = code?.[1] ?? token?.[1]
    const expiry = code?.[1].expiresAt ?? intent?.expiresAt ?? token?.[1].grant.expiresAt ?? revocation?.[1]
    if (expiry === undefined) {
      yield* sql`DELETE FROM attach_grants WHERE origin = ${origin} AND reference = ${row.reference}`
    } else {
      if (code !== undefined && row.grant_id === null) {
        // Reserve the grant slot at approval, so anonymous redemption needs only its own code row.
        const [used] = yield* sql<{ readonly count: number }>`
          SELECT count(*)::int AS count FROM attach_grants
          WHERE origin = ${origin} AND grant_id IS NOT NULL
            AND (code_hash IS NOT NULL OR expires_at > ${Date.now()})`
        if (used!.count >= ATTACH_LIMITS.tokens) return Result.fail("too_many" as const)
      }
      yield* sql`
        UPDATE attach_grants SET claim_id = ${intent?.claim?.id ?? null},
          code_hash = ${code?.[0] ?? null}, token_hash = ${token?.[0] ?? revocation?.[0] ?? null},
          grant_id = ${issued?.grant.id ?? row.grant_id}, expires_at = ${expiry}, state = ${snapshot}::jsonb
        WHERE origin = ${origin} AND reference = ${row.reference}`
    }
    return outcome
  }))
})

const mint = (origin: string, input: Parameters<LiveAttach["mintIntent"]>[0]) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const attach = makeAttach({ hostOrigin: origin, permissions })
  const result = yield* attach.mintIntent(input)
  if (Result.isFailure(result)) return result
  const { reference, expiresAt } = result.success
  const person = input.actor.subject.id
  return yield* sql.withTransaction(Effect.gen(function* () {
    yield* capacityLock(sql, origin)
    const now = Date.now()
    // Reclaim expired rows opportunistically. Skip attachments still in use by another transaction.
    yield* sql`
      WITH expired AS (
        SELECT reference FROM attach_grants WHERE origin = ${origin} AND expires_at <= ${now}
        ORDER BY expires_at LIMIT 128 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM attach_grants a USING expired e WHERE a.origin = ${origin} AND a.reference = e.reference`
    const [used] = yield* sql<{ readonly total: number; readonly personal: number }>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE person_id = ${person})::int AS personal
      FROM attach_grants WHERE origin = ${origin} AND token_hash IS NULL AND expires_at > ${now}`
    if (used!.total >= ATTACH_LIMITS.intents || used!.personal >= ATTACH_LIMITS.intentsPerPerson) {
      return Result.fail("too_many" as const)
    }
    const inserted = yield* sql`
      INSERT INTO attach_grants (origin, reference, person_id, expires_at, state)
      VALUES (${origin}, ${reference}, ${person}, ${expiresAt}, ${JSON.stringify(attach.snapshot())}::jsonb)
      ON CONFLICT (origin, reference) DO NOTHING RETURNING reference`
    return inserted.length === 0 ? Result.fail("too_many" as const) : result
  }))
})

const serveMcp = (origin: string, web: Request, body: Result.Result<string, "too_large" | "body">) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const key = yield* Effect.promise(() => bearerHash(web.headers.get("authorization")))
    const answers: Array<MessagesShardBridge.Answered> = []
    const serve = (state?: AttachState) => makeMcpRoute({
      attach: makeAttach({ hostOrigin: origin, permissions, state }),
      hostOrigin: origin, tools, pathPrefix: ATTACH_MCP_ROUTE,
    })(web, body).pipe(Effect.provideService(RecordedAnswers, { record: (answer) => void answers.push(answer) }))
    const target = targetOf(new URL(web.url), ATTACH_MCP_ROUTE)
    if (key === undefined || target === undefined) return yield* serve()
    const [candidate] = yield* sql<AttachmentRow>`
      SELECT reference, grant_id, state FROM attach_grants WHERE origin = ${origin} AND token_hash = ${key}`
    const issued = candidate?.state.tokens[0]?.[1]
    if (issued === undefined || issued.grant.expiresAt <= Date.now() ||
      issued.grant.repo !== target.repo || issued.grant.branch !== target.branch) return yield* serve(candidate?.state)
    // Only a live, known token takes a shared row lock. Hold it through the tool's database effects.
    const response = yield* sql.withTransaction(Effect.gen(function* () {
      const [current] = yield* sql<AttachmentRow>`
        SELECT reference, grant_id, state FROM attach_grants WHERE origin = ${origin} AND token_hash = ${key} FOR SHARE`
      return yield* serve(current?.state)
    }))
    // Committed: the locks are released and the connection is returned before the shard is reached. A transaction
    // that rolled back, or whose commit failed, never gets here, so the shard never holds an answer Postgres does not.
    // The bridge never fails; an answer it could not send is sent by the same answer given again.
    yield* Effect.forEach(answers, MessagesShardBridge.answered, { discard: true })
    return response
  })

const decode = <P extends AttachPath>(path: P, body: string) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(routes[path]), { onExcessProperty: "error" })(body)

const noStore = { "cache-control": "no-store" }
const refused = (status: number, code: string) =>
  HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
const reply = (result: Result.Result<unknown, AttachRefusal>, status: number) =>
  Result.isFailure(result) ? refused(REFUSAL_STATUS[result.failure], result.failure)
    : status === 204 ? HttpServerResponse.empty({ status, headers: noStore })
    : HttpServerResponse.jsonUnsafe(result.success, { status, headers: noStore })

const personRoute = (path: Exclude<AttachPath, typeof ATTACH_CLAIMS_ROUTE | typeof ATTACH_TOKENS_ROUTE>,
  body: string, origin: string, request: Request, actor: Actor) =>
  Effect.gen(function* () {
    const person = { request, actor }
    switch (path) {
      case ATTACH_INTENTS_ROUTE: {
        const input = decode(path, body)
        if (Option.isNone(input)) return refused(400, "invalid")
        return reply(yield* mint(origin, {
          ...input.value,
          ...person,
          repo: input.value.repo.toLowerCase(),
          conversation: input.value.conversation.toLowerCase(),
        }), 201)
      }
      case ATTACH_CONSENT_ROUTE: {
        const input = decode(path, body)
        if (Option.isNone(input)) return refused(400, "invalid")
        return reply(yield* changeAttachment(origin, "reference", normalizeReference(input.value.reference),
          (attach) => Effect.sync(() => attach.consentFor({ ...input.value, ...person }))), 200)
      }
      case ATTACH_APPROVALS_ROUTE: {
        const input = decode(path, body)
        if (Option.isNone(input)) return refused(400, "invalid")
        return reply(yield* changeAttachment(origin, "claim_id", input.value.claim,
          (attach) => attach.approveIntent({ ...input.value, ...person })), 200)
      }
      case ATTACH_REVOCATIONS_ROUTE: {
        const input = decode(path, body)
        if (Option.isNone(input)) return refused(400, "invalid")
        return reply(yield* changeAttachment(origin, "grant_id", input.value.grant,
          (attach) => Effect.sync(() => attach.revokeGrant({ ...input.value, ...person }))), 204)
      }
    }
  })

const requests = Metric.counter("smithers_attach_requests", { incremental: true })

export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = canonicalPath(request.url.split("?")[0]!)
    const route = isMcpPath(path) ? "mcp" : isAttachPath(path) ? path : "unknown"
    const start = yield* Clock.currentTimeMillis
    const response = yield* Effect.gen(function* () {
      if (!handles(path)) return refused(404, "not_found")
      const web = yield* HttpServerRequest.toWeb(request)
      const origin = new URL(web.url).origin
      const callerOrigin = web.headers.get("origin")
      if (callerOrigin !== null && callerOrigin !== origin) return refused(403, "wrong_origin")
      if (request.method !== "POST") {
        return HttpServerResponse.empty({ status: 405, headers: { ...noStore, allow: "POST" } })
      }
      const body = yield* Effect.promise(() => readBody(web, MCP_MAX_REQUEST_BYTES))
      if (Result.isFailure(body)) return refused(body.failure === "too_large" ? 413 : 400, "invalid")
      if (isMcpPath(path)) {
        const response = yield* serveMcp(origin, web, body)
        return HttpServerResponse.fromWeb(response)
      }
      if (!isAttachPath(path)) return refused(404, "not_found")
      if (path === ATTACH_CLAIMS_ROUTE) {
        const input = decode(path, body.success)
        if (Option.isNone(input)) return refused(400, "invalid")
        return reply(yield* changeAttachment(origin, "reference", normalizeReference(input.value.reference),
          (attach) => Effect.sync(() => attach.claimIntent(input.value))), 201)
      }
      if (path === ATTACH_TOKENS_ROUTE) {
        const input = decode(path, body.success)
        if (Option.isNone(input)) return refused(400, "invalid")
        const hash = yield* Effect.promise(() => hashCredential(input.value.code))
        const redeemed = yield* changeAttachment(origin, "code_hash", hash,
          (attach) => Effect.promise(() => attach.redeemCode(input.value)))
        return reply(Result.map(redeemed, (receipt) => {
          const [owner, name] = receipt.grant.repo.split("/")
          return { ...receipt, mcpPath: attachMcpRoute(owner!, name!, receipt.grant.branch) }
        }), 200)
      }
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return refused(401, "unauthenticated")
      if (actor.value.act !== undefined) return refused(403, "person_only")
      if (callerOrigin !== origin) return refused(403, "wrong_origin")
      return yield* personRoute(path, body.success, origin, web, actor.value)
    }).pipe(
      Effect.provide(database),
      Effect.catchCause((cause) => Effect.annotateCurrentSpan({ "error.code": codeOf(Cause.squash(cause)) }).pipe(
        Effect.as(refused(503, "unavailable")),
      )),
    )
    const status = response.status
    yield* Metric.update(Metric.withAttributes(requests, { route, status: String(status) }), 1)
    yield* Effect.annotateCurrentSpan({ route, "http.response.status_code": status })
    yield* Effect.logWithLevel(status >= 500 ? "Error" : status >= 400 ? "Warn" : "Info")("attach.request").pipe(
      Effect.annotateLogs({ route, status, durationMs: (yield* Clock.currentTimeMillis) - start }),
    )
    return response
  }).pipe(Effect.withSpan("attach.request", { kind: "server" }))
  return { fetch }
}

