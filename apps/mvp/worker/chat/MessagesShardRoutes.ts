import {
  Chat as ChatState,
  ChatEvent,
  MAX_BODY_LENGTH,
  MAX_DATA_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_MARK_LENGTH,
  MAX_PARTS,
  MAX_SUMMARY_LENGTH,
  MessageFailure,
  MessagePart,
} from "@smthrs/app-state"
import type { ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardProtocol } from "@smthrs/sync"
import { Cause, Data, Effect, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { type Actor, refusesPersonOnly, Sessions } from "../Actor.vibe"
import { MAX_MESSAGES_SHARD_BYTES, readBounded } from "../Body.vibe"
import { askingOf, type BranchAccess, canView } from "../branch/Access.vibe"
import * as MessagesShard from "./MessagesShard.ts"

// The messages shard over HTTP (decision 0170, slice 3). The Worker authenticates the session, decides read and write
// from the person's access to the conversation's branch, and sends the conversation's own Durable Object a fresh
// request carrying only its admission. The object serves protocol v2: Submit, Pull and Snapshot.
//
// Who writes stays on the server (decision 0013). A shard's authors and keys reach every reader of the conversation on
// Pull and Snapshot, so a writer is admitted under an owner name that is a keyed digest of who they are in this one
// conversation (`ownerOf`): the same writer is the same owner there and nowhere else, and no reader can turn the name
// back into a person or test a guess against it. The key is the Worker's (`OwnerSecret`); a Worker with none admits no
// submit from a page or a run, and still serves Pull, Snapshot and ChatApi's own writes (`submitAs`).
//
// The whole key a command is journaled under is the conversation's own too (`scopedKey`): the device a page names and
// the command id it counts are replaced, before the object sees them, by keyed digests under this conversation, and
// the page is answered under the key it sent. Two conversations a person writes in from one device share no text a
// reader of both can see.
//
// Every name the Worker makes is sealed (`sealed`): its digest, then a keyed check of that digest under the
// conversation and what the name is for. Only the Worker can make one, and only for that conversation, so whether a
// journaled name is the Worker's is proved on its way out of Pull and Snapshot (`published`), never read off how it is
// spelled: a name that does not carry this conversation's seal, whatever it looks like, was journaled before these
// names existed, or by a caller who chose it, and leaves as a digest of itself. The bridge's names are a message's own
// id, and are themselves.

const respond = (body: unknown) => HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "no-store" } })
const status = (code: number) => HttpServerResponse.empty({ status: code })
const notAllowed = (allow: string) => HttpServerResponse.empty({ status: 405, headers: { allow } })

/**
 * What a request is answered while the conversation's shard does not hold its history from Postgres yet
 * (worker/chat/MessagesShardBackfill.vibe `ensureIn`): try again in a second.
 */
export const incomplete = HttpServerResponse.jsonUnsafe(
  { error: "shard_backfill_incomplete", retryable: true },
  { status: 503, headers: { "cache-control": "no-store", "retry-after": "1" } },
)

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
const decodePullResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ShardProtocol.PullResponse))
const decodeSnapshotResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ShardProtocol.SnapshotResponse))
const BackfillState = Schema.Struct({ checked: Schema.Boolean, cursor: Schema.Number })
const decodeBackfill = Schema.decodeUnknownEffect(Schema.fromJsonString(BackfillState))
const decodeBatch = Schema.decodeUnknownEffect(Schema.fromJsonString(MessagesShard.BackfillBatch))
const BackfillResult = Schema.Struct({
  applied: Schema.Number,
  kept: Schema.Number,
  cursor: Schema.Number,
  checked: Schema.Boolean,
  rejected: Schema.optionalKey(Schema.Struct({ index: Schema.Number, messageId: Schema.String, code: Schema.String })),
})
const decodeBatchResult = Schema.decodeUnknownEffect(Schema.fromJsonString(BackfillResult))

/**
 * The author the Worker's backfill asks the object under (`backfillState`, `markBackfilled`, `backfillBatch`). No route
 * a page or a run reaches admits anyone as it: `dispatch` admits a reader as `reader` and a writer under an owner name
 * `ownerOf` gives, which starts with a person's or a run's kind, and forwards no path but submit, pull and snapshot.
 */
const BACKFILLER = "worker:backfill"

/** The object's paths only the Worker's backfill reaches: its mark and cursor, and a batch of its commands. */
export const BACKFILL_MARK_PATH = "/internal/backfill-mark"
export const BACKFILL_BATCH_PATH = "/internal/backfill-batch"

/** The most entries one Pull answers, whatever `limit` asks: its `through` and `done` then name the page it sent. */
export const MAX_PULL_LIMIT = 256

// The longest submit the object is sent, as JSON in UTF-8, for each command ChatApi's bridge builds
// (worker/chat/MessagesShardBridge.ts) and for a page's submit as the Worker forwards it (`dispatch`). A bridged
// command is measured as its JSON with every string the reducer bounds empty and every count at 0, which is ASCII, so
// its length is its bytes. Each bounded string then adds six bytes for each UTF-16 code unit it may hold: the escape
// JSON writes a control character or a lone surrogate as (`\u0001`). A unit written as itself is at most three bytes,
// and a surrogate pair four for its two units. Each count, the epoch included, adds 15 bytes: `Number.MAX_SAFE_INTEGER`,
// the largest count the reducer and the protocol admit, is 16 digits where 0 is one. Ids are UUIDs, 36 ASCII
// characters. A status update and an answer's empty post hold ids, a literal and one label at most, and are shorter
// than every command below.
const UNIT_BYTES = 6
const COUNT_BYTES = String(Number.MAX_SAFE_INTEGER).length - 1
const ID = "00000000-0000-4000-8000-000000000000"
const SHARD = `conv:${ID}`
const QUESTION = MessagesShard.questionOwner(ID)
const ANSWER = MessagesShard.answerOwner(ID)
const longest = (literals: ReadonlyArray<string>) => literals.reduce((long, literal) => literal.length > long.length ? literal : long)

/** The longest submit of a command `author` sends under `id`: `units` bounded code units and `counts` counts besides its epoch. */
const bridgedBytes = (author: string, id: string, payload: object, units: number, counts: number) =>
  JSON.stringify({
    version: ShardProtocol.protocolVersion,
    shard: SHARD,
    epoch: 0,
    command: { key: [`${author}/${MessagesShard.BRIDGE_DEVICE}`, id], stream: SHARD, payload },
  }).length + UNIT_BYTES * units + COUNT_BYTES * (counts + 1)

/** The longest a sealed key spells (`scopedKey`): the longest owner kind, then three sealed names. */
const SEALED_KEY_BYTES = JSON.stringify([`sandbox:${"0".repeat(80)}/${"0".repeat(80)}`, "0".repeat(80)]).length

/**
 * The longest submit of each command the object is sent, in bytes:
 * - `question`, a question's post: its body (`MAX_BODY_LENGTH`), its time and its view's id and event (three
 *   `MAX_LABEL_LENGTH`), its values (`MAX_DATA_LENGTH`) and its position.
 * - `body`, an answer's body update: its body (`MAX_BODY_LENGTH`, what `bodyWithin` keeps).
 * - `run`, what an answer's run wrote and how it ended: `MAX_PARTS` steps of two labels and the longest status each,
 *   its model, its stop reason and its time (three labels), the time again in its key, the longest failure, and its
 *   two token counts.
 * - `note`, the timeline's note on a question: its summary (`MAX_SUMMARY_LENGTH`), its revision (a label), its phase
 *   and its arc (two `MAX_MARK_LENGTH`) and its version, under the longest key a note is sent under.
 * - `page`, a page's submit: what the Worker reads of it (`MAX_MESSAGES_SHARD_BYTES`), and, at most, a sealed key in
 *   place of the one it sent.
 */
export const COMMAND_BYTES = {
  question: bridgedBytes(QUESTION, `question:${ID}`, {
    _tag: "PostMessage",
    messageId: ID,
    author: QUESTION,
    body: "",
    role: "user",
    position: 0,
    createdAt: "",
    source: { viewId: "", event: "" },
    data: "",
  }, MAX_BODY_LENGTH + 3 * MAX_LABEL_LENGTH + MAX_DATA_LENGTH, 1),
  body: bridgedBytes(ANSWER, `body:${ID}:${MAX_BODY_LENGTH}`, {
    _tag: "UpdateMessageBody",
    messageId: ID,
    author: ANSWER,
    body: "",
  }, MAX_BODY_LENGTH, 0),
  run: bridgedBytes(ANSWER, `failure:${ID}:`, {
    _tag: "UpdateMessageMetadata",
    messageId: ID,
    parts: Array.from({ length: MAX_PARTS }, () => ({ id: "", kind: "step", flow: "", status: longest(MessagePart.fields.status.literals) })),
    modelId: "",
    stopReason: "",
    inputTokens: 0,
    outputTokens: 0,
    updatedAt: "",
    failure: longest(MessageFailure.literals),
  }, MAX_PARTS * 2 * MAX_LABEL_LENGTH + 4 * MAX_LABEL_LENGTH, 2),
  note: bridgedBytes(QUESTION, `noted:${ID}:${Number.MAX_SAFE_INTEGER}:again`, {
    _tag: "UpdateMessageMetadata",
    messageId: ID,
    summary: "",
    summaryRevision: "",
    phase: "",
    arc: "",
    noteVersion: 0,
  }, MAX_SUMMARY_LENGTH + MAX_LABEL_LENGTH + 2 * MAX_MARK_LENGTH, 1),
  page: MAX_MESSAGES_SHARD_BYTES + SEALED_KEY_BYTES,
} as const

/**
 * The most bytes the object reads of a submit: the longest in `COMMAND_BYTES`, rounded up to a multiple of 64 KiB.
 * Every command the reducer takes in any of those shapes fits, so a stored answer is never refused for the size of
 * its encoding and its end is always sent. 320 KiB (327,680 bytes): a question's post is the longest, 295,445 bytes,
 * then a run's 206,645 (64 steps of 3,124 bytes each), a page's 196,864 and an answer's body 192,422. The Worker's own
 * cap on a page's submit stays `MAX_MESSAGES_SHARD_BYTES`.
 */
export const MAX_SHARD_COMMAND_BYTES = Math.ceil(Math.max(...Object.values(COMMAND_BYTES)) / 65_536) * 65_536

/**
 * The most bytes the object reads of a backfill batch (`BACKFILL_BATCH_PATH`): 4 MiB, so a batch of the longest
 * commands still holds twelve (`MAX_SHARD_COMMAND_BYTES` each), and a batch of ordinary ones the most it may hold.
 */
export const MAX_BACKFILL_BATCH_BYTES = 4 * 1_048_576

/** The bound object's routes for `messages`. A submit's body is read under its cap before the admission is. */
export const handle = (messages: MessagesShard.LiveMessages) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "https://messages.internal")
    const submits = request.method === "POST" && url.pathname === "/api/messages/submit"
    const batches = request.method === "POST" && url.pathname === BACKFILL_BATCH_PATH
    const body = submits
      ? yield* readBounded(request, MAX_SHARD_COMMAND_BYTES, undefined, true)
      : batches
      ? yield* readBounded(request, MAX_BACKFILL_BATCH_BYTES, undefined, true)
      : ""
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
    // The backfill's mark and cursor, and its batches (worker/chat/MessagesShardBackfill.vibe): read by the Worker's
    // backfill, and written by it, only.
    if (url.pathname === BACKFILL_MARK_PATH) {
      if (author !== BACKFILLER) return status(403)
      if (request.method === "GET") {
        return respond({ checked: yield* messages.backfill.checked, cursor: yield* messages.backfill.cursor })
      }
      if (request.method !== "POST") return status(404)
      if (!write) return status(403)
      yield* messages.backfill.check
      return respond({ checked: true, cursor: yield* messages.backfill.cursor })
    }
    if (url.pathname === BACKFILL_BATCH_PATH) {
      if (author !== BACKFILLER) return status(403)
      if (!batches) return status(404)
      if (!write) return status(403)
      return respond(yield* messages.backfill.batch(yield* decodeBatch(body)))
    }
    return status(404)
  }).pipe(Effect.catch((error) => {
    if (error._tag === "BodyRefused" && error.reason === "too_large") return Effect.succeed(status(413))
    if (error._tag === "MessagesRefused" && error.reason !== "invalid") {
      return Effect.succeed(HttpServerResponse.empty({ status: 403, headers: { [refusalHeader]: error.reason } }))
    }
    return Effect.succeed(status(400))
  }))

/**
 * The bound object's handler over its own SQLite: `{ storage }`, never `{ db: storage.sql }` (decision 0170). What the
 * Alchemy-declared object serves (MessagesShardObject.ts), and what a plain Durable Object serves in local workerd
 * (worker/test/workerd/messages.ts).
 */
export const handlerOf = (storage: ObjectDatabase.Storage, shard: ShardProtocol.ShardId) =>
  Effect.map(MessagesShard.make(storage, shard).pipe(Effect.provide(Reactivity.layer)), handle)

const conversationPath =
  /^\/api\/conversations\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/messages\/(submit|pull|snapshot|writer)$/

export const handles = (path: string): boolean => conversationPath.test(path)

/** The Worker's secret the owner names are keyed with. Never logged, and never sent to an object or a page. */
export type OwnerSecret = Redacted.Redacted<string>

/** What a reading request is admitted as: it writes nothing, so it names nobody. */
const READER = "reader"

const encoder = new TextEncoder()

/**
 * The digest an owner name ends with: HMAC-SHA-256 under the Worker's secret, over a label of this use and `parts` as
 * JSON, in lowercase hexadecimal. JSON keeps the parts apart, so no two lists of parts spell the same text.
 */
const digestOf = (secret: OwnerSecret, parts: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(["smithers.messages.owner.v1", ...parts])))
    return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("")
  })

/** How many hexadecimal characters of its keyed check a sealed name ends with: 64 bits. */
const CHECK_LENGTH = 16
const SEALED = /^[0-9a-f]{80}$/

/** What a sealed name is for: its check is another under each, so no name passes as one of another use. */
type Use = "owner" | "device" | "command"

/** The keyed check of `digest` as a name for `use` in `conversation`. */
const checkOf = (secret: OwnerSecret, conversation: string, use: Use, digest: string): Effect.Effect<string> =>
  Effect.map(digestOf(secret, ["seal", conversation, use, digest]), (check) => check.slice(0, CHECK_LENGTH))

/**
 * The name the Worker gives `parts` for `use` in `conversation`: their digest, then its check. Lowercase hexadecimal
 * and nothing else, so it holds no `/` and no `:`.
 */
const sealed = (secret: OwnerSecret, conversation: string, use: Use, parts: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.flatMap(digestOf(secret, parts), (digest) =>
    Effect.map(checkOf(secret, conversation, use, digest), (check) => digest + check))

/**
 * Whether the Worker made `name` for `use` in `conversation`: it is spelled as a sealed name and its check is the one
 * this Worker's secret gives its digest there. Nobody without the secret makes a name that passes, and a name sealed
 * for another conversation, or another use, does not.
 */
const isSealed = (secret: OwnerSecret, conversation: string, use: Use, name: string): Effect.Effect<boolean> =>
  !SEALED.test(name)
    ? Effect.succeed(false)
    : Effect.map(checkOf(secret, conversation, use, name.slice(0, -CHECK_LENGTH)), (check) => name.endsWith(check))

/**
 * The owner name of person `id` in conversation `conversationId`: their messages' author there and their nodes'
 * prefix. `person:` and a sealed digest, so it reads as a person's (MessagesShard.ts `PERSON_OWNER_PREFIX`), never contains
 * the `/` that starts a device or a second `:`, and says nothing of who the person is. The same person in another
 * conversation is another owner.
 */
export const personOwner = (secret: OwnerSecret, conversationId: string, id: string): Effect.Effect<string> => {
  const conversation = conversationId.toLowerCase()
  return Effect.map(sealed(secret, conversation, "owner", ["person", conversation, id]), (name) => "person:" + name)
}

/**
 * The owner name a submitter's messages carry in conversation `conversationId`: the person's (`personOwner`), or the
 * run acting for them, never the person's. A run's is its act kind and a sealed digest of the verified subject it acts for,
 * its chain's root and its own execution id, so two people's runs of the same name are two owners, and no run id,
 * slashes included, reaches into another owner's nodes or onto the wire.
 */
export const ownerOf = (secret: OwnerSecret, conversationId: string, actor: Actor): Effect.Effect<string> => {
  const { act } = actor
  if (act === undefined) return personOwner(secret, conversationId, actor.subject.id)
  const conversation = conversationId.toLowerCase()
  return Effect.map(
    sealed(secret, conversation, "owner", ["run", conversation, act.kind, actor.subject.id, act.root ?? act.id, act.id]),
    (name) => `${act.kind}:${name}`,
  )
}

const decodeKey = Schema.decodeUnknownSync(ShardProtocol.CommandKey)

/**
 * The key a command of `owner` is journaled under in conversation `conversationId`, for the key its submitter sent:
 * the owner, a sealed digest of the device the submitter named and one of its command id, each under this conversation.
 * The same command sent again is the same key, so the shard still answers it from its receipt; the same device and
 * the same command id in another conversation are other text. Whatever the submitter sent is digested, a sealed name
 * included, so nothing a submitter chose is journaled as one of the Worker's. A key whose node is not one of the
 * owner's is left as it is: the object refuses it (`origin`) and journals nothing.
 */
export const scopedKey = (
  secret: OwnerSecret,
  conversationId: string,
  owner: string,
  key: ShardProtocol.CommandKey,
): Effect.Effect<ShardProtocol.CommandKey> =>
  !MessagesShard.ownsOrigin(owner, key[0]) ? Effect.succeed(key) : Effect.gen(function*() {
    const conversation = conversationId.toLowerCase()
    const device = yield* sealed(secret, conversation, "device", ["device", conversation, owner, key[0].slice(owner.length + 1)])
    const node = `${owner}/${device}`
    return decodeKey([node, yield* sealed(secret, conversation, "command", ["command", conversation, node, key[1]])])
  })

/** The kinds an owner name `ownerOf` gives starts with. */
const OWNER_KIND = /^(person|agent|flow|app|sandbox):(.*)$/
/** An owner name ChatApi's bridge writes under: a message's own id, which every reader already holds. */
const BRIDGE_OWNER = /^(?:person:question|answer):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * What leaves a shard on Pull and Snapshot, for conversation `conversationId`: `author` gives the name an author is
 * read under, and `key` the key an entry is. A name the bridge made is itself. So is one the Worker sealed for this
 * conversation (`isSealed`): an owner name `ownerOf` gave, and a key whose owner, device and command id `scopedKey`
 * gave, all three. Any other was journaled before those existed, or was chosen by whoever submitted it, and may spell
 * a person, a run or a device, or repeat a name from another conversation, however much it looks like a digest: it
 * leaves as a keyed digest of itself under this conversation, a person's still a person's
 * (`MessagesShard.PERSON_OWNER_PREFIX`), so the same old writer is one name in one conversation and unlinkable across
 * two. A Worker with no secret has made no name and has nothing to key a digest with: it says `redacted` in place of
 * every name but the bridge's.
 */
const published = (secret: OwnerSecret | undefined, conversationId: string) => {
  const digest = (use: string, parts: ReadonlyArray<string>) =>
    secret === undefined ? Effect.succeed("redacted") : digestOf(secret, [use, conversationId, ...parts])
  const made = (use: Use, name: string) => secret === undefined ? Effect.succeed(false) : isSealed(secret, conversationId, use, name)
  const author = (name: string): Effect.Effect<string> =>
    BRIDGE_OWNER.test(name) ? Effect.succeed(name) : Effect.flatMap(made("owner", OWNER_KIND.exec(name)?.[2] ?? ""), (ours) =>
      ours
        ? Effect.succeed(name)
        : Effect.map(digest("legacy", [name]), (hex) => `${name.startsWith("person:") ? "person" : "legacy"}:${hex}`))
  const key = ([node, id]: readonly [string, string]): Effect.Effect<readonly [string, string]> => {
    const slash = node.indexOf("/")
    const owner = slash === -1 ? node : node.slice(0, slash)
    const device = slash === -1 ? "" : node.slice(slash + 1)
    if (BRIDGE_OWNER.test(owner) && device === MessagesShard.BRIDGE_DEVICE) return Effect.succeed([node, id])
    return Effect.gen(function*() {
      const name = yield* author(owner)
      // The Worker's own key is all three of its names: one of them a submitter chose makes it a key to rewrite.
      if (name === owner && (yield* made("device", device)) && (yield* made("command", id))) return [node, id] as const
      return [`${name}/${yield* digest("legacy-device", [node])}`, yield* digest("legacy-command", [node, id])] as const
    })
  }
  return { author, key }
}

const decodeEvent = Schema.decodeUnknownEffect(ChatEvent)
const decodeState = Schema.decodeUnknownEffect(Schema.NullOr(Schema.Struct({ chat: ChatState })))

/** A Pull's answer as readers are given it: each entry's key, and the author each posted event names. */
const publishedPull = (names: ReturnType<typeof published>, text: string) =>
  Effect.gen(function*() {
    const answer = yield* decodePullResponse(text)
    if (answer._tag === "Resync") return answer
    const entries = yield* Effect.forEach(answer.entries, (entry) =>
      Effect.gen(function*() {
        const events = yield* Effect.forEach(entry.events, (journaled) =>
          Effect.flatMap(decodeEvent(journaled), (event): Effect.Effect<typeof ChatEvent.Type> =>
            event._tag === "MessagePosted"
              ? Effect.map(names.author(event.author), (author) => ({ ...event, author }))
              : Effect.succeed(event)))
        return { ...entry, key: yield* names.key(entry.key), events }
      }))
    return { ...answer, entries }
  })

/** A Snapshot's answer as readers are given it: the author of each message its state holds. */
const publishedSnapshot = (names: ReturnType<typeof published>, text: string) =>
  Effect.gen(function*() {
    const answer = yield* decodeSnapshotResponse(text)
    const state = yield* decodeState(answer.state)
    // Nothing is folded before the first compaction: there is no state to name anyone in.
    if (state === null) return answer
    const messages = yield* Effect.forEach(state.chat.messages, (message) =>
      Effect.map(names.author(message.author), (author) => ({ ...message, author })))
    return { ...answer, state: { chat: { messages } } }
  })

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

/** Whatever went wrong reaching the object, kept as `unreachable` and nothing more: the failure can quote the request. */
const unreachable = <A, E, R>(attempt: Effect.Effect<A, E, R>): Effect.Effect<A, SubmitFailed, R> =>
  attempt.pipe(Effect.catchCause((cause) => {
    const failure = Cause.squash(cause)
    return Effect.fail(failure instanceof SubmitFailed ? failure : new SubmitFailed({ reason: "unreachable" }))
  }))

/**
 * Sends the object of `shard` one request of the Worker's backfill (worker/chat/MessagesShardBackfill.vibe), and reads
 * its answer with `decode`. Any status but 200 is `refused`, an answer `decode` does not read `invalid_response`, and
 * anything else `unreachable`.
 */
const backfillCall = <A, E, R>(
  forward: Forward<E, R>,
  shard: ShardProtocol.ShardId,
  path: string,
  method: "GET" | "POST",
  decode: (text: string) => Effect.Effect<A, unknown>,
  body?: string,
) =>
  unreachable(Effect.gen(function*() {
    const outgoing = HttpServerRequest.fromWeb(new Request(`https://messages.internal${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: { [admissionHeader]: JSON.stringify({ author: BACKFILLER, write: method === "POST" }) },
    }))
    const response = yield* forward(shard, outgoing)
    if (response.status !== 200) return yield* new SubmitFailed({ reason: "refused", status: response.status })
    const text = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())
    return yield* decode(text).pipe(Effect.mapError(() => new SubmitFailed({ reason: "invalid_response", status: 200 })))
  }))

/** The object of `shard`'s backfill mark, and how far its backfill got (`MessagesShard.BackfillBatch.cursor`). */
export const backfillState = <E, R>(forward: Forward<E, R>, shard: ShardProtocol.ShardId) =>
  backfillCall(forward, shard, BACKFILL_MARK_PATH, "GET", decodeBackfill)

/** Whether the object of `shard` holds its conversation's history from Postgres (`backfillState`). */
export const backfilled = <E, R>(forward: Forward<E, R>, shard: ShardProtocol.ShardId) =>
  Effect.map(backfillState(forward, shard), (state) => state.checked)

/** Marks the object of `shard` as holding its conversation's history from Postgres. Idempotent. */
export const markBackfilled = <E, R>(forward: Forward<E, R>, shard: ShardProtocol.ShardId) =>
  Effect.asVoid(backfillCall(forward, shard, BACKFILL_MARK_PATH, "POST", decodeBackfill))

/** Applies one batch of the backfill in the object of `shard`, in one call (`MessagesShard.make` `backfill.batch`). */
export const backfillBatch = <E, R>(
  forward: Forward<E, R>,
  shard: ShardProtocol.ShardId,
  batch: MessagesShard.BackfillBatch,
): Effect.Effect<MessagesShard.BackfillResult, SubmitFailed, R> =>
  backfillCall(forward, shard, BACKFILL_BATCH_PATH, "POST", decodeBatchResult, JSON.stringify(batch))

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
  unreachable(Effect.gen(function*() {
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
  }))

/**
 * Admits a request to its conversation's shard. Only this Worker can call the bound object, and it overwrites any
 * client-supplied admission. The body is read under its cap before anyone is authenticated or anything is decoded.
 * `access` is what the asker may do on the conversation's branch (`branchAccess`), `undefined` when there is none.
 * A submit the Worker cannot decode is refused here and never forwarded, so the object reads only a body the Worker
 * read the same way. Which message ids a writer may post under is the object's own rule (MessagesShard.ts
 * `BRIDGE_ID`): the Worker admits nobody under a bridge owner name (`ownerOf`) and asks Postgres nothing.
 *
 * `secret` keys the owner names writers are admitted under. Without one there is no name a writer could carry that
 * says nothing of them, so a submit is refused (`403`) once the asker is known to read the conversation; Pull and
 * Snapshot are served as ever, and name nobody.
 *
 * `writer` (a `GET`) answers the asker's own owner name in the conversation, `{ owner }`: a page writes its messages
 * under it and cannot build it. It is told to whoever may read the conversation, and to nobody about anyone else.
 *
 * `before` runs before a Pull, a Snapshot or a Submit is forwarded, once the asker is known to read the conversation
 * and the request is one the object serves (a read it would answer with its method, a submit with its method that the
 * Worker decoded, that names this shard and its stream, from a writer it admits): the conversation's history in
 * Postgres is replayed into a shard that does not hold it yet (worker/chat/MessagesShardBackfill.vibe `ensure`). It
 * answers whether the shard holds that history now; one that does not is answered `503` (`incomplete`), so no reader
 * is served, and no writer adds to, a shard that lacks what Postgres held before the bridge. `barrier` then runs
 * before a Pull or a Snapshot only: what the shard is still owed is sent first (worker/chat/MessagesShardSource.ts
 * `drain`), so a reader is never served a shard that lacks a write Postgres committed and could be given. Neither
 * fails.
 */
export const dispatch = <E, R, E2, R2, R3 = never, R4 = never>(
  forward: Forward<E2, R2>,
  access: (actor: Actor, conversationId: string) => Effect.Effect<BranchAccess | undefined, E, R>,
  secret: OwnerSecret | undefined,
  barrier?: (conversationId: string) => Effect.Effect<void, never, R3>,
  before?: (conversationId: string) => Effect.Effect<boolean, never, R4>,
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
  const route = match[2] as "submit" | "pull" | "snapshot" | "writer"
  if (route === "writer") {
    if (request.method !== "GET") return status(404)
    // The asker's own name, and only where there is a key to make one with.
    return secret === undefined ? status(403) : respond({ owner: yield* ownerOf(secret, conversationId, actor) })
  }
  const submits = route === "submit"
  // A request the object would not serve is answered here, before Postgres or the bridge is asked anything for it:
  // another method is `405`, a query or a submit that does not decode is `400`, one that names another shard is
  // `403`, and so is a submit from someone who may not write.
  if (request.method !== (submits ? "POST" : "GET")) return notAllowed(submits ? "POST" : "GET")
  if (!submits) {
    const asked = route === "pull"
      ? Option.map(yield* Effect.option(ShardProtocol.decodePullQuery(url.searchParams)), (query) => query.shard)
      : yield* Effect.option(Schema.decodeUnknownEffect(ShardProtocol.ShardId)(url.searchParams.get("shard")))
    if (Option.isNone(asked)) return status(400)
    if (asked.value !== shard) return status(403)
  }
  // Only a submit names its writer, and only by the conversation's own digest of them. A read names nobody.
  const named = submits ? secret : undefined
  if (submits && named === undefined) return status(403)
  const write = askingOf(found) === "ask" && permits(MessagesShard.writeCapability(shard))
  const submitted = submits ? MessagesShard.readSubmit(body!) : Option.none()
  if (submits && Option.isNone(submitted)) return status(400)
  if (submits && !write) return status(403)
  // A submit to another shard, or another stream: refused as the object refuses it (`MessagesShard.make` `admit`).
  if (Option.isSome(submitted) && (submitted.value.shard !== shard || (submitted.value.command.stream as string) !== shard)) {
    return HttpServerResponse.empty({ status: 403, headers: { [refusalHeader]: "wrong_shard" } })
  }
  const admission = named === undefined ? { author: READER, write: false } : {
    author: yield* ownerOf(named, conversationId, actor),
    ...(actor.act === undefined ? {} : { person: yield* personOwner(named, conversationId, actor.subject.id) }),
    write,
  }
  // The key the object journals is the conversation's own: the one the submitter sent is kept here, to answer under.
  const sent = Option.map(submitted, (submit) => submit.command.key)
  const scoped = named === undefined || Option.isNone(submitted)
    ? Option.none()
    : Option.some(yield* scopedKey(named, conversationId, admission.author, submitted.value.command.key))
  const forwarded = Option.isSome(submitted) && Option.isSome(scoped)
    ? JSON.stringify({ ...submitted.value, command: { ...submitted.value.command, key: scoped.value } })
    : body
  // A shard that does not hold the conversation's history yet serves nobody, and sequences nothing: a read would take
  // part of it for all of it, and a write would take a place ahead of the history still to come.
  if (before !== undefined && !(yield* before(conversationId))) return incomplete
  if (!submits && barrier !== undefined) yield* barrier(conversationId)
  const target = `https://messages.internal/api/messages/${route}${url.search}`
  const outgoing = HttpServerRequest.fromWeb(new Request(target, {
    method: request.method,
    ...(forwarded === undefined ? {} : { body: forwarded }),
    headers: { [admissionHeader]: JSON.stringify(admission) },
  }))
  const response = yield* forward(shard, outgoing)
  // A run that posted under its person's name: counted and logged as every person-only refusal is, except that its run
  // id is text its launcher chose, so the log line leaves it out.
  if (response.headers[refusalHeader] === "person_only") {
    yield* refusesPersonOnly(actor, "conversation/ask", { runId: false })
  }
  if (response.status !== 200) return response
  const text = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())
  // A submit's answer names the key the submitter sent, never the one the object journaled.
  if (Option.isSome(sent)) return respond({ ...(yield* decodeSubmitResponse(text)), key: sent.value })
  const names = published(secret, conversationId)
  return respond(route === "snapshot" ? yield* publishedSnapshot(names, text) : yield* publishedPull(names, text))
}).pipe(
  Effect.orElseSucceed(() => status(503)),
  Effect.withSpan("messages.route"),
)
