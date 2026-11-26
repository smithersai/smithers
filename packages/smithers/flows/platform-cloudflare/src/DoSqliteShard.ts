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
 * ```ts
 * const shard = DoSqliteShard.layer(ctx.storage, { shard: "repo:acme/widgets" })
 * ```
 *
 * @since 1.0.0-rc.18
 */

import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import { ShardProtocol, ShardServer } from "@smthrs/sync"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import type { Storage } from "./ObjectDatabase.ts"

/**
 * A JSON value.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Json = ShardProtocol.Command["payload"]

/**
 * `[originNodeId, commandId]`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type CommandKey = ShardProtocol.CommandKey

/**
 * A command to sequence.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Command = ShardProtocol.Command

/**
 * A position in the shard's order under an epoch.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Position = ShardProtocol.ShardPosition

/**
 * One sequenced entry.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Entry = ShardProtocol.Entry

/**
 * The answer to a submit, as `ShardProtocol.SubmitResponse`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type SubmitResponse = ShardProtocol.SubmitResponse

/**
 * The answer to a pull, as `ShardProtocol.PullResponse`.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type PullResponse = ShardProtocol.PullResponse

/**
 * The authority's verdict on one command.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Decision = ShardServer.Decision

/**
 * The shard, as the object serves it.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Service = ShardServer.ShardServer

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
  `CREATE TABLE IF NOT EXISTS shard_snapshot (
    shard TEXT PRIMARY KEY, floor INTEGER NOT NULL, state TEXT NOT NULL)`,
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
  readonly floor: number
  readonly state: string
}

interface EntryRow {
  readonly seq: number
  readonly epoch: number
  readonly origin_node: string
  readonly command_id: string
  readonly stream: string
  readonly events: string
}

/**
 * The shard sequencer over `storage`, with the Effect client for host queries. Creates its tables on first use.
 * An empty shard name can only reopen existing history for reads.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const make: (
  storage: Storage,
  options: Options
) => Effect.Effect<
  {
    readonly client: SqliteClient.SqliteClient
    readonly shard: Service
    /** The receipt the sequencer keeps for `key`, if it already decided that key: what a retry is answered from. */
    readonly receipt: (key: CommandKey) => ShardServer.Receipt | undefined
  },
  never,
  Scope.Scope | Reactivity.Reactivity
> =
  Effect.fnUntraced(function*(storage: Storage, options: Options) {
  const shard = yield* Schema.decodeUnknownEffect(ShardProtocol.PullRequest.fields.shard)(options.shard).pipe(Effect.orDie)
  const client = yield* SqliteClient.make({ storage })
  const exec = <T>(query: string, ...bindings: Array<unknown>): Array<T> =>
    storage.sql.exec(query, ...bindings).toArray() as unknown as Array<T>
  storage.transactionSync(() => {
    for (const table of tables) exec(table)
    if (shard === "") {
      const [legacy] = exec(`SELECT 1 FROM shard_head WHERE shard = ?`, shard)
      if (legacy === undefined) throw new Error("Cannot create a shard with an empty name")
    } else {
      exec(`INSERT OR IGNORE INTO shard_head (shard, epoch, head) VALUES (?, 0, 0)`, shard)
    }
  })
  let pending: Array<Entry> = []
  const store: ShardServer.ShardStore = {
    atomic: (body) => storage.transactionSync(() => {
      const outer = pending
      const entries: Array<Entry> = []
      pending = entries
      try {
        const result = body()
        for (const entry of entries) options.beforeCommit?.(entry)
        return result
      } finally {
        pending = outer
      }
    }),
    head: () => {
      const row = exec<HeadRow>(
        `SELECT h.epoch, h.head, COALESCE(s.floor, 0) AS floor, COALESCE(s.state, 'null') AS state
         FROM shard_head h LEFT JOIN shard_snapshot s ON s.shard = h.shard WHERE h.shard = ?`,
        shard
      )[0]!
      return { epoch: row.epoch, head: row.head, floor: row.floor, snapshot: JSON.parse(row.state) as Json }
    },
    setHead: (next) => {
      exec(`UPDATE shard_head SET epoch = ?, head = ? WHERE shard = ?`, next.epoch, next.head, shard)
      if (next.floor > 0 || next.snapshot !== null) {
        exec(
          `INSERT INTO shard_snapshot (shard, floor, state) VALUES (?, ?, ?)
           ON CONFLICT(shard) DO UPDATE SET floor = excluded.floor, state = excluded.state
           WHERE floor <> excluded.floor OR state <> excluded.state`,
          shard, next.floor, JSON.stringify(next.snapshot)
        )
      } else {
        exec(`DELETE FROM shard_snapshot WHERE shard = ?`, shard)
      }
    },
    receipt: (key) => exec<ShardServer.Receipt>(
      `SELECT hash, epoch, seq, reason FROM shard_receipts WHERE shard = ? AND origin_node = ? AND command_id = ?`,
      shard, ...key
    )[0],
    putReceipt: (key, receipt) => {
      exec(
        `INSERT INTO shard_receipts (shard, origin_node, command_id, hash, epoch, seq, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        shard, ...key, receipt.hash, receipt.epoch, receipt.seq, receipt.reason
      )
    },
    append: (entry) => {
      exec(
        `INSERT INTO shard_entries (shard, seq, epoch, origin_node, command_id, stream, events) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        shard, entry.seq, entry.epoch, ...entry.key, entry.stream, JSON.stringify(entry.events)
      )
      pending.push(entry)
    },
    read: (after, limit) => exec<EntryRow>(
      `SELECT seq, epoch, origin_node, command_id, stream, events
       FROM shard_entries WHERE shard = ? AND seq > ? ORDER BY seq LIMIT ?`,
      shard, after, limit
    ).map((row) => ({
      seq: row.seq,
      epoch: row.epoch,
      key: [row.origin_node, row.command_id],
      stream: row.stream,
      events: JSON.parse(row.events) as ReadonlyArray<Json>
    })),
    dropThrough: (seq) => {
      exec(`DELETE FROM shard_entries WHERE shard = ? AND seq <= ?`, shard, seq)
    }
  }
  const service = ShardServer.make({
    shard,
    store,
    ...(options.decide === undefined ? {} : { decide: options.decide })
  })
  return { client, shard: service, receipt: store.receipt }
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
