/**
 * A shard sequencer in a SQLite-backed Durable Object: protocol v2
 * (`@smthrs/sync`'s `ShardProtocol`) answered from the object's own storage.
 *
 * One object is the authority of one shard. Its order, its command receipts
 * and its epoch live in the object's SQLite, so an object that hibernates or
 * restarts wakes with its history intact: the next accepted command takes the
 * next seq, a retried command is answered from its receipt, and a reader
 * resumes after its own cursor. Nothing is refetched.
 *
 * Two Cloudflare rules shape it:
 *
 * - The Effect client is built from `{ storage: ctx.storage }`, never
 *   `{ db: ctx.storage.sql }`: only the storage form supports
 *   `withTransaction`. The layer provides that client as `SqlClient` too, for
 *   the host's own queries.
 * - SQLite in a Durable Object refuses `BEGIN`. Each submit decides and writes
 *   inside one `ctx.storage.transactionSync`, so its receipt, its entry and the
 *   head move together or not at all. The table's
 *   `UNIQUE (shard, origin_node, command_id)` refuses a second entry for a key
 *   even if a receipt were lost.
 *
 * Reads run through the Effect client. A page reads the head first and bounds
 * its entries by it, so a submit that commits between the two reads never
 * tears a page.
 *
 * Compaction is not part of this slice: the snapshot is always the empty
 * state at seq 0, and a reader that resyncs replays from the start.
 *
 * ```ts
 * const shard = DoSqliteShard.layer(ctx.storage, { shard: "repo:acme/widgets" })
 * ```
 *
 * @since 1.0.0-rc.18
 */

import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { Storage } from "./ObjectDatabase.ts"

/**
 * A JSON value.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/**
 * `[originNodeId, commandId]`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type CommandKey = readonly [originNodeId: string, commandId: string]

/**
 * A command to sequence.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Command {
  readonly key: CommandKey
  readonly stream: string
  readonly payload: Json
}

/**
 * A position in the shard's order under an epoch.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Position {
  readonly shard: string
  readonly epoch: number
  readonly seq: number
}

/**
 * One sequenced entry.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Entry {
  readonly seq: number
  readonly epoch: number
  readonly key: CommandKey
  readonly stream: string
  readonly events: ReadonlyArray<Json>
}

/**
 * The answer to a submit, as `ShardProtocol.SubmitResponse`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type SubmitResponse =
  | { readonly _tag: "Accepted"; readonly key: CommandKey; readonly position: Position }
  | { readonly _tag: "Duplicate"; readonly key: CommandKey; readonly position: Position }
  | { readonly _tag: "Refused"; readonly key: CommandKey; readonly reason: string }
  | { readonly _tag: "StaleEpoch"; readonly key: CommandKey; readonly shard: string; readonly epoch: number }
  | { readonly _tag: "IdempotencyConflict"; readonly key: CommandKey; readonly position: Position | null }

/**
 * The answer to a pull, as `ShardProtocol.PullResponse`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type PullResponse =
  | {
    readonly _tag: "Page"
    readonly shard: string
    readonly epoch: number
    readonly entries: ReadonlyArray<Entry>
    readonly through: number
    readonly head: number
    readonly done: boolean
  }
  | { readonly _tag: "Resync"; readonly shard: string; readonly epoch: number; readonly snapshotSeq: number }

/**
 * The authority's verdict on one command.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Decision =
  | { readonly _tag: "Accepted"; readonly events: ReadonlyArray<Json> }
  | { readonly _tag: "Refused"; readonly reason: string }

/**
 * The shard, as the object serves it.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Service {
  readonly shard: string
  readonly submit: (request: {
    readonly version: 2
    readonly shard: string
    readonly epoch: number
    readonly command: Command
  }) => Effect.Effect<SubmitResponse>
  readonly pull: (request: {
    readonly version: 2
    readonly shard: string
    readonly epoch: number
    readonly after: number
    readonly limit: number
  }) => Effect.Effect<PullResponse, SqlError>
  readonly snapshot: (shard: string) => Effect.Effect<{ readonly position: Position; readonly state: Json }, SqlError>
  readonly head: Effect.Effect<Position, SqlError>
  /** Fences the current authority: writers and readers under the old epoch are refused or resynced. */
  readonly advanceEpoch: Effect.Effect<Position>
}

/**
 * The shard this object sequences.
 *
 * @category services
 * @since 1.0.0-rc.18
 */
export class DoSqliteShard extends Context.Service<DoSqliteShard, Service>()(
  "@smthrs/platform-cloudflare/DoSqliteShard"
) {}

/**
 * Options for {@link make}. `decide` defaults to accepting every command with
 * its payload as the one event. `beforeCommit` runs inside the transaction
 * after a command's writes; if it throws, the transaction rolls back.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Options {
  readonly shard: string
  readonly decide?: (command: Command) => Decision
  readonly beforeCommit?: (entry: Entry) => void
}

const tables = [
  `CREATE TABLE IF NOT EXISTS shard_head (
    shard TEXT PRIMARY KEY, epoch INTEGER NOT NULL, head INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shard_entries (
    shard TEXT NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL,
    origin_node TEXT NOT NULL, command_id TEXT NOT NULL, stream TEXT NOT NULL, events TEXT NOT NULL,
    PRIMARY KEY (shard, seq), UNIQUE (shard, origin_node, command_id))`,
  `CREATE TABLE IF NOT EXISTS shard_receipts (
    shard TEXT NOT NULL, origin_node TEXT NOT NULL, command_id TEXT NOT NULL,
    hash TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER, reason TEXT,
    PRIMARY KEY (shard, origin_node, command_id))`
]

interface HeadRow {
  readonly epoch: number
  readonly head: number
}

interface ReceiptRow {
  readonly hash: string
  readonly epoch: number
  readonly seq: number | null
  readonly reason: string | null
}

interface EntryRow {
  readonly seq: number
  readonly epoch: number
  readonly origin_node: string
  readonly command_id: string
  readonly stream: string
  readonly events: string
}

const canonicalJson = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  const object = value as { readonly [key: string]: Json }
  return `{${
    Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")
  }}`
}

// The same hash as `ShardProtocol.contentHash`, so a key's receipt agrees across hosts.
const contentHash = (command: Command) =>
  Effect.promise(() =>
    globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson({ stream: command.stream, payload: command.payload }))
    )
  ).pipe(
    Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
  )

const acceptAll = (command: Command): Decision => ({ _tag: "Accepted", events: [command.payload] })

/**
 * The shard sequencer over `storage`, with the Effect client it reads
 * through. Creates its tables on first use.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const make = Effect.fnUntraced(function*(storage: Storage, options: Options) {
  const { shard } = options
  const decide = options.decide ?? acceptAll
  const client = yield* SqliteClient.make({ storage })
  const exec = <T>(query: string, ...bindings: Array<unknown>): Array<T> =>
    storage.sql.exec(query, ...bindings).toArray() as unknown as Array<T>
  storage.transactionSync(() => {
    for (const table of tables) exec(table)
    exec(`INSERT OR IGNORE INTO shard_head (shard, epoch, head) VALUES (?, 0, 0)`, shard)
  })
  const currentHead = () => exec<HeadRow>(`SELECT epoch, head FROM shard_head WHERE shard = ?`, shard)[0]!
  const at = (epoch: number, seq: number): Position => ({ shard, epoch, seq })
  // A request routed to the wrong object is a routing bug, not an answer.
  const owned = (requested: string) =>
    requested === shard ? Effect.void : Effect.die(new Error(`this object sequences ${shard}, not ${requested}`))

  const sequence = (command: Command, epoch: number, hash: string): SubmitResponse => {
    const { key } = command
    const current = currentHead()
    if (epoch !== current.epoch) return { _tag: "StaleEpoch", key, shard, epoch: current.epoch }
    const prior = exec<ReceiptRow>(
      `SELECT hash, epoch, seq, reason FROM shard_receipts WHERE shard = ? AND origin_node = ? AND command_id = ?`,
      shard,
      key[0],
      key[1]
    )[0]
    if (prior !== undefined) {
      const position = prior.seq === null ? null : at(prior.epoch, prior.seq)
      if (prior.hash !== hash) return { _tag: "IdempotencyConflict", key, position }
      return position === null ? { _tag: "Refused", key, reason: prior.reason! } : { _tag: "Duplicate", key, position }
    }
    const decision = decide(command)
    const receipt = (seq: number | null, reason: string | null) =>
      exec(
        `INSERT INTO shard_receipts (shard, origin_node, command_id, hash, epoch, seq, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        shard,
        key[0],
        key[1],
        hash,
        current.epoch,
        seq,
        reason
      )
    if (decision._tag === "Refused") {
      receipt(null, decision.reason)
      return { _tag: "Refused", key, reason: decision.reason }
    }
    const entry: Entry = {
      seq: current.head + 1,
      epoch: current.epoch,
      key,
      stream: command.stream,
      events: decision.events
    }
    exec(
      `INSERT INTO shard_entries (shard, seq, epoch, origin_node, command_id, stream, events) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      shard,
      entry.seq,
      entry.epoch,
      key[0],
      key[1],
      entry.stream,
      JSON.stringify(entry.events)
    )
    receipt(entry.seq, null)
    exec(`UPDATE shard_head SET head = ? WHERE shard = ?`, entry.seq, shard)
    options.beforeCommit?.(entry)
    return { _tag: "Accepted", key, position: at(entry.epoch, entry.seq) }
  }

  const readHead = Effect.map(
    client<HeadRow>`SELECT epoch, head FROM shard_head WHERE shard = ${shard}`,
    (rows) => rows[0]!
  )

  const service: Service = {
    shard,
    submit: (request) =>
      owned(request.shard).pipe(
        Effect.andThen(contentHash(request.command)),
        Effect.map((hash) => storage.transactionSync(() => sequence(request.command, request.epoch, hash)))
      ),
    pull: (request) =>
      Effect.gen(function*() {
        yield* owned(request.shard)
        const current = yield* readHead
        if (request.epoch !== current.epoch || request.after > current.head) {
          return { _tag: "Resync", shard, epoch: current.epoch, snapshotSeq: 0 } as const
        }
        const through = Math.min(request.after + request.limit, current.head)
        const rows = yield* client<EntryRow>`SELECT seq, epoch, origin_node, command_id, stream, events
          FROM shard_entries WHERE shard = ${shard} AND seq > ${request.after} AND seq <= ${through} ORDER BY seq`
        return {
          _tag: "Page",
          shard,
          epoch: current.epoch,
          entries: rows.map((row) => ({
            seq: row.seq,
            epoch: row.epoch,
            key: [row.origin_node, row.command_id] as const,
            stream: row.stream,
            events: JSON.parse(row.events) as ReadonlyArray<Json>
          })),
          through,
          head: current.head,
          done: through === current.head
        } as const
      }),
    snapshot: (requested) =>
      owned(requested).pipe(
        Effect.andThen(readHead),
        Effect.map((current) => ({ position: at(current.epoch, 0), state: null }))
      ),
    head: Effect.map(readHead, (current) => at(current.epoch, current.head)),
    advanceEpoch: Effect.sync(() =>
      storage.transactionSync(() => {
        exec(`UPDATE shard_head SET epoch = epoch + 1 WHERE shard = ?`, shard)
        const current = currentHead()
        return at(current.epoch, current.head)
      })
    )
  }
  return { client, shard: service }
})

/**
 * Provides the shard as {@link DoSqliteShard}, and the Effect client built
 * from `{ storage }` as `SqlClient`.
 *
 * @category layers
 * @since 1.0.0-rc.18
 */
export const layer = (storage: Storage, options: Options): Layer.Layer<DoSqliteShard | SqlClient.SqlClient> =>
  Layer.effectContext(
    Effect.map(
      make(storage, options),
      ({ client, shard }) => Context.make(DoSqliteShard, shard).pipe(Context.add(SqlClient.SqlClient, client))
    )
  ).pipe(Layer.provide(Reactivity.layer))
