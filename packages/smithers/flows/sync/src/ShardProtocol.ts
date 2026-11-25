/**
 * Protocol v2: the wire contract between a shard's one sequencer and the
 * nodes that write to it and read from it.
 *
 * A shard is the unit of total order. One authority sequences it per epoch
 * and assigns every accepted command the next `seq`, gapless and monotonic.
 * A node submits commands from its local outbox, each named by a
 * {@link CommandKey}, so a retry of the same command is answered with the
 * receipt it already has instead of a second entry. A node reads by pulling
 * pages after its applied cursor; when its cursor or epoch no longer matches
 * the shard's history, the page answer is `Resync`, and the node rebuilds from
 * a {@link SnapshotResponse} plus the entries after it.
 *
 * Every pull parameter is a scalar, so a pull is a plain HTTP `GET`:
 * {@link pullQuery} and {@link decodePullQuery} carry it in a query string.
 *
 * ```text
 * Submit(shard, epoch, command) -> Accepted | Duplicate | Refused | StaleEpoch | IdempotencyConflict
 * Pull(shard, epoch, after, limit) -> Page{entries, through, head, done} | Resync{epoch, snapshotSeq}
 * Snapshot(shard) -> {position, state}
 * ```
 *
 * @since 1.0.0-rc.18
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * The shard wire revision. Version 1 is `SyncProtocol`'s journal read path.
 *
 * @category constants
 * @since 1.0.0-rc.18
 */
export const protocolVersion = 2

/**
 * The kinds of stream a shard sequences, as the prefix of a {@link StreamId}.
 *
 * @category constants
 * @since 1.0.0-rc.18
 */
export const streamKinds = ["repo", "repo-maint", "person", "run", "conv", "doc", "github"] as const

/**
 * A stream kind.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type StreamKind = typeof streamKinds[number]

/**
 * A stream inside a shard: a kind prefix, a colon, and a non-empty name, such
 * as `repo:acme/widgets` or `run:01J...`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const StreamId = Schema.String.check(
  Schema.isPattern(new RegExp(`^(?:${streamKinds.join("|")}):.+$`))
).pipe(Schema.brand("@smthrs/sync/ShardProtocol/StreamId"))

/**
 * A stream inside a shard.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type StreamId = typeof StreamId.Type

/**
 * The kind of a stream, read from its prefix.
 *
 * @category accessors
 * @since 1.0.0-rc.18
 */
export const streamKind = (stream: StreamId): StreamKind =>
  // The prefix runs to the first colon, so `repo-maint:x` is never read as `repo`.
  stream.slice(0, stream.indexOf(":")) as StreamKind

const HistoricalShardId = Schema.String.pipe(Schema.brand("@smthrs/sync/ShardProtocol/ShardId"))

/**
 * The name of one shard, such as `repo:acme/widgets`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const ShardId = HistoricalShardId.check(Schema.isMinLength(1))

/**
 * The name of one shard.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type ShardId = typeof ShardId.Type

/**
 * The fencing token of a shard's authority. A new authority takes the next
 * epoch; a writer or reader holding an older one is refused or resynced.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Epoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * A position in a shard's total order. `0` is before the first entry.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The node a command came from.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const NodeId = Schema.NonEmptyString

/**
 * A command's id, unique among its origin node's commands.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const CommandId = Schema.NonEmptyString

/**
 * A command's idempotency key: `[originNodeId, commandId]`. A shard accepts
 * each key once.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const CommandKey = Schema.Tuple([NodeId, CommandId])

/**
 * A command's idempotency key.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type CommandKey = typeof CommandKey.Type

/**
 * One position in one shard's history under one epoch.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const ShardPosition = Schema.Struct({ shard: HistoricalShardId, epoch: Epoch, seq: Seq })

/**
 * One position in one shard's history under one epoch.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type ShardPosition = typeof ShardPosition.Type

/**
 * A command a node asks the shard to sequence. `payload` is JSON; its
 * canonical form, with `stream`, is the content the idempotency key binds.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Command = Schema.Struct({ key: CommandKey, stream: StreamId, payload: Schema.Json })

/**
 * A command a node asks the shard to sequence.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Command = typeof Command.Type

/**
 * One sequenced entry: the command and the events the authority decided from
 * it, at its position.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Entry = Schema.Struct({
  seq: Seq,
  epoch: Epoch,
  // History predates the constraints on new command keys and stream names.
  key: Schema.Tuple([Schema.String, Schema.String]),
  stream: Schema.String,
  events: Schema.Array(Schema.Json)
})

/**
 * One sequenced entry.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Entry = typeof Entry.Type

/**
 * Asks the shard to sequence one command under the writer's known epoch.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const SubmitRequest = Schema.Struct({
  version: Schema.Literal(protocolVersion),
  shard: ShardId,
  epoch: Epoch,
  command: Command
})

/**
 * Asks the shard to sequence one command.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type SubmitRequest = typeof SubmitRequest.Type

/**
 * The command is sequenced at `position` for the first time.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Accepted = Schema.TaggedStruct("Accepted", { key: CommandKey, position: ShardPosition })

/**
 * The command was sequenced before, at `position`; nothing new is written.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Duplicate = Schema.TaggedStruct("Duplicate", { key: CommandKey, position: ShardPosition })

/**
 * The authority decided against the command. The refusal is the key's
 * receipt: a retry is refused with the same reason.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Refused = Schema.TaggedStruct("Refused", { key: CommandKey, shard: ShardId, reason: Schema.String })

/**
 * The writer's epoch is not the shard's. Nothing was decided; resubmit under
 * `epoch`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const StaleEpoch = Schema.TaggedStruct("StaleEpoch", { key: CommandKey, shard: ShardId, epoch: Epoch })

/**
 * The key was already used for a command with different content. The first
 * command stands; this one is never sequenced.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const IdempotencyConflict = Schema.TaggedStruct("IdempotencyConflict", {
  key: CommandKey,
  shard: ShardId,
  position: Schema.NullOr(ShardPosition)
})

/**
 * The shard's answer to a {@link SubmitRequest}.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const SubmitResponse = Schema.Union([Accepted, Duplicate, Refused, StaleEpoch, IdempotencyConflict])

/**
 * The shard's answer to a {@link SubmitRequest}.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type SubmitResponse = typeof SubmitResponse.Type

/**
 * Asks for up to `limit` entries after `after`, under the reader's known
 * epoch. Every field is a scalar, so it travels as a query string.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const PullRequest = Schema.Struct({
  version: Schema.Literal(protocolVersion),
  shard: HistoricalShardId,
  epoch: Epoch,
  after: Seq,
  limit: Schema.Int.check(Schema.isGreaterThan(0))
})

/**
 * Asks for a page of entries.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type PullRequest = typeof PullRequest.Type

/**
 * A page of consecutive entries `after + 1 .. through`. `head` is the shard's
 * last seq when the page was read; `done` is `through === head`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Page = Schema.TaggedStruct("Page", {
  shard: HistoricalShardId,
  epoch: Epoch,
  entries: Schema.Array(Entry),
  through: Seq,
  head: Seq,
  done: Schema.Boolean
})

/**
 * The reader's cursor or epoch no longer names a point in the shard's
 * history. Rebuild from the snapshot at `snapshotSeq` under `epoch`, then pull
 * after it.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const Resync = Schema.TaggedStruct("Resync", { shard: HistoricalShardId, epoch: Epoch, snapshotSeq: Seq })

/**
 * The shard's answer to a {@link PullRequest}.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const PullResponse = Schema.Union([Page, Resync])

/**
 * The shard's answer to a {@link PullRequest}.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type PullResponse = typeof PullResponse.Type

/**
 * The shard's state folded through `position.seq`. `state` is `null` before
 * the first compaction: rebuild from an empty projection and pull from `0`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export const SnapshotResponse = Schema.Struct({ position: ShardPosition, state: Schema.Json })

/**
 * The shard's state folded through a position.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type SnapshotResponse = typeof SnapshotResponse.Type

/**
 * A pull request as `GET` query parameters.
 *
 * @category encoding
 * @since 1.0.0-rc.18
 */
export const pullQuery = (request: PullRequest): URLSearchParams =>
  new URLSearchParams({
    v: String(request.version),
    shard: request.shard,
    epoch: String(request.epoch),
    after: String(request.after),
    limit: String(request.limit)
  })

const PullQuery = Schema.Struct({
  v: Schema.NumberFromString,
  shard: Schema.String,
  epoch: Schema.NumberFromString,
  after: Schema.NumberFromString,
  limit: Schema.NumberFromString
})

const decodeQuery = Schema.decodeUnknownEffect(PullQuery)
const decodeRequest = Schema.decodeUnknownEffect(PullRequest)

/**
 * Reads a pull request from `GET` query parameters, refusing a missing or
 * malformed field with the schema's error.
 *
 * @category encoding
 * @since 1.0.0-rc.18
 */
export const decodePullQuery = (params: URLSearchParams): Effect.Effect<PullRequest, Schema.SchemaError> =>
  Effect.flatMap(
    decodeQuery(Object.fromEntries(params)),
    (query) =>
      decodeRequest({
        version: query.v,
        shard: query.shard,
        epoch: query.epoch,
        after: query.after,
        limit: query.limit
      })
  )

/**
 * A request the shard cannot answer: it names another shard, or a position
 * outside the shard's retained history.
 *
 * @category errors
 * @since 1.0.0-rc.18
 */
export class ShardError extends Schema.TaggedError<ShardError>()("@smthrs/sync/ShardError", {
  reason: Schema.Literals(["wrong_shard", "out_of_range"]),
  message: Schema.String
}) {}

/**
 * The canonical JSON text of a value: object keys sorted, no whitespace. Two
 * values with the same content have the same text.
 *
 * @category encoding
 * @since 1.0.0-rc.18
 */
export const canonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  const object = value as { readonly [key: string]: Schema.Json }
  return `{${
    Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")
  }}`
}

/**
 * The content a command's key binds: the SHA-256 of the canonical JSON of its
 * stream and payload, as hex. Web Crypto, so it runs in a browser, Node and
 * workerd alike.
 *
 * @category encoding
 * @since 1.0.0-rc.18
 */
export const contentHash = (command: Command): Effect.Effect<string> =>
  Effect.promise(() =>
    globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson({ stream: command.stream, payload: command.payload }))
    )
  ).pipe(
    Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
  )
