import { ShardProtocol } from "@smthrs/sync"
import { Cause, Data, Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { type Actor, refusesPersonOnly, Sessions } from "../Actor.vibe"
import { MAX_MESSAGES_SHARD_BYTES, readBounded } from "../Body.vibe"
import { askingOf, type BranchAccess, canView } from "../branch/Access.vibe"
import * as MessagesShard from "./MessagesShard.ts"

// The messages shard over HTTP (decision 0170, slice 3). The Worker authenticates the session, decides read and write
// from the person's access to the conversation's branch, and sends the conversation's own Durable Object a fresh
// request carrying only its admission. The object serves protocol v2: Submit, Pull and Snapshot.

const respond = (body: unknown) => HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "no-store" } })
const status = (code: number) => HttpServerResponse.empty({ status: code })

/** Names why the object refused a write, for the Worker's own count of person-only refusals. */
export const refusalHeader = "x-smithers-messages-refusal"
const admissionHeader = "x-smithers-messages-admission"

const Admission = Schema.Struct({
  author: Schema.String,
  person: Schema.optional(Schema.String),
  write: Schema.Boolean
})
const decodeAdmission = Schema.decodeUnknownOption(Schema.fromJsonString(Admission))
const decodeSubmitResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ShardProtocol.SubmitResponse))

/** The most entries one Pull answers, whatever `limit` asks: its `through` and `done` then name the page it sent. */
export const MAX_PULL_LIMIT = 256

/** The bound object's routes for `messages`. A submit's body is read under its cap before the admission is. */
export const handle = (messages: MessagesShard.LiveMessages) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "https://messages.internal")
    const submits = request.method === "POST" && url.pathname === "/api/messages/submit"
    const body = submits ? yield* readBounded(request, MAX_MESSAGES_SHARD_BYTES, undefined, true) : ""
    const admission = decodeAdmission(request.headers[admissionHeader])
    if (Option.isNone(admission)) return status(403)
    const { author, person, write } = admission.value
    if (submits) {
      if (!write) return status(403)
      return respond(yield* messages.submit({ author, ...(person === undefined ? {} : { person }) }, body))
    }
    if (request.method === "GET" && url.pathname === "/api/messages/pull") {
      const query = yield* ShardProtocol.decodePullQuery(url.searchParams)
      if (query.shard !== messages.shard) return status(403)
      return respond(yield* messages.journal.pull({ ...query, limit: Math.min(query.limit, MAX_PULL_LIMIT) }))
    }
    if (request.method === "GET" && url.pathname === "/api/messages/snapshot") {
      const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.ShardId)(url.searchParams.get("shard"))
      if (shard !== messages.shard) return status(403)
      return respond(yield* messages.journal.snapshot(shard))
    }
    return status(404)
  }).pipe(Effect.catch((error) => {
    if (error._tag === "BodyRefused" && error.reason === "too_large") return Effect.succeed(status(413))
    if (error._tag === "MessagesRefused" && error.reason !== "invalid") {
      return Effect.succeed(HttpServerResponse.empty({ status: 403, headers: { [refusalHeader]: error.reason } }))
    }
    return Effect.succeed(status(400))
  }))

const conversationPath =
  /^\/api\/conversations\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/messages\/(submit|pull|snapshot)$/

export const handles = (path: string): boolean => conversationPath.test(path)

/**
 * The owner name of person `id`: their messages' author and their nodes' prefix. Each part of an owner name is
 * percent-encoded, so it never contains the `/` that starts a device or the `:` that separates its parts.
 */
export const personOwner = (id: string): string => "person:" + encodeURIComponent(id)

/**
 * The owner name a submitter's messages carry: the person's (`person:<subject>`), or the run acting for them, never
 * the person's. A run's is its act kind, the verified subject it acts for, its chain's root and its own execution id
 * (`<kind>:<subject>:<root>:<run>`), so two people's runs of the same name are two owners, and no run id, slashes
 * included, reaches into another owner's nodes.
 */
export const ownerOf = (actor: Actor): string =>
  actor.act === undefined
    ? personOwner(actor.subject.id)
    : [actor.act.kind, actor.subject.id, actor.act.root ?? actor.act.id, actor.act.id].map(encodeURIComponent).join(":")

/** How the Worker reaches a conversation's object: its binding in production, the object's own handler in a test. */
export type Forward<E = never, R = never> = (
  shard: ShardProtocol.ShardId,
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>

/** The object gave no protocol answer to a submit the Worker itself sent: its status, and the refusal it named. */
export class SubmitFailed extends Data.TaggedError("MessagesSubmitFailed")<{
  readonly reason: "unreachable" | "refused" | "invalid_response"
  readonly status?: number
  readonly refusal?: string
}> {}

/**
 * Sequences `request` on its shard for `writer`, from inside the Worker: what ChatApi's own writes use
 * (worker/chat/MessagesShardBridge.ts). The Worker has already decided who writes, so the admission is its own; the
 * object still applies every rule it applies to a browser's submit. Whatever goes wrong reaching the object is
 * `unreachable`, with nothing of the failure kept: it can quote the request.
 */
export const submitAs = <E, R>(
  forward: Forward<E, R>,
  writer: MessagesShard.Writer,
  request: ShardProtocol.SubmitRequest,
): Effect.Effect<ShardProtocol.SubmitResponse, SubmitFailed, R> =>
  Effect.gen(function*() {
    const outgoing = HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/submit", {
      method: "POST",
      body: JSON.stringify(request),
      headers: { [admissionHeader]: JSON.stringify({ ...writer, write: true }) },
    }))
    const response = yield* forward(request.shard, outgoing)
    if (response.status !== 200) {
      const refusal = response.headers[refusalHeader]
      return yield* new SubmitFailed({
        reason: "refused",
        status: response.status,
        ...(refusal === undefined ? {} : { refusal }),
      })
    }
    const text = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())
    const answer = yield* decodeSubmitResponse(text).pipe(
      Effect.mapError(() => new SubmitFailed({ reason: "invalid_response", status: 200 })),
    )
    // An answer is this command's only when it names the command's key and shard, and a conflict's position, where it
    // has one, is in that shard too (`@smthrs/sync` ShardClient `matchesShard`): any other is no answer at all.
    const [node, id] = request.command.key
    const answered = answer._tag === "Accepted" || answer._tag === "Duplicate" ? answer.position.shard : answer.shard
    const elsewhere = answer._tag === "IdempotencyConflict" && answer.position !== null &&
      answer.position.shard !== request.shard
    if (answer.key[0] !== node || answer.key[1] !== id || answered !== request.shard || elsewhere) {
      return yield* new SubmitFailed({ reason: "invalid_response", status: 200 })
    }
    return answer
  }).pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.squash(cause)
      return Effect.fail(failure instanceof SubmitFailed ? failure : new SubmitFailed({ reason: "unreachable" }))
    }),
  )

/**
 * Admits a request to its conversation's shard. Only this Worker can call the bound object, and it overwrites any
 * client-supplied admission. The body is read under its cap before anyone is authenticated or anything is decoded.
 * `access` is what the asker may do on the conversation's branch (`branchAccess`), `undefined` when there is none.
 * A submit the Worker cannot decode is refused here and never forwarded, so the object reads only a body the Worker
 * read the same way. Which message ids a writer may post under is the object's own rule (MessagesShard.ts
 * `BRIDGE_ID`): the Worker admits nobody under a bridge owner name (`ownerOf`) and asks Postgres nothing.
 */
export const dispatch = <E, R, E2, R2>(
  forward: Forward<E2, R2>,
  access: (actor: Actor, conversationId: string) => Effect.Effect<BranchAccess | undefined, E, R>,
) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "https://messages.internal")
  const match = conversationPath.exec(url.pathname)
  if (!match) return status(404)
  const content = yield* (request.method === "POST" ? readBounded(request, MAX_MESSAGES_SHARD_BYTES, undefined, true) : Effect.undefined)
    .pipe(Effect.result)
  if (content._tag === "Failure") return status(content.failure.reason === "too_large" ? 413 : 400)
  const body = content.success
  const current = yield* (yield* Sessions).resolve
  if (Option.isNone(current)) return status(401)
  const actor = current.value
  const conversationId = match[1]!.toLowerCase()
  const found = yield* access(actor, conversationId)
  if (found === undefined) return status(404)
  const shard = MessagesShard.shardOf(conversationId)
  // A run reads and writes only inside a ceiling that names this shard; the person's own session has none.
  const permits = (capability: string) => actor.act === undefined ||
    (actor.act.ceiling !== undefined && actor.act.ceiling.length > 0 &&
      actor.act.ceiling.every((group) => group.includes(capability)))
  if (!canView(found.access) || !permits(MessagesShard.readCapability(shard))) return status(403)
  const write = askingOf(found) === "ask" && permits(MessagesShard.writeCapability(shard))
  if (body !== undefined && match[2] === "submit" && !MessagesShard.decodes(body)) return status(400)
  const target = `https://messages.internal/api/messages/${match[2]}${url.search}`
  const outgoing = HttpServerRequest.fromWeb(new Request(target, {
    method: request.method,
    ...(body === undefined ? {} : { body }),
    headers: {
      [admissionHeader]: JSON.stringify({
        author: ownerOf(actor),
        ...(actor.act === undefined ? {} : { person: personOwner(actor.subject.id) }),
        write,
      }),
    },
  }))
  const response = yield* forward(shard, outgoing)
  // A run that posted under its person's name: counted and logged as every person-only refusal is, except that its run
  // id is text its launcher chose, so the log line leaves it out.
  if (response.headers[refusalHeader] === "person_only") {
    yield* refusesPersonOnly(actor, "conversation/ask", { runId: false })
  }
  return response
}).pipe(
  Effect.orElseSucceed(() => status(503)),
  Effect.withSpan("messages.route"),
)
