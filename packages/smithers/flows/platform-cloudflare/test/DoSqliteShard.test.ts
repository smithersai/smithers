/**
 * `DoSqliteShard` over an in-memory double of a SQLite-backed Durable
 * Object's storage: `sql.exec` over `node:sqlite` that refuses transaction
 * SQL as the real one does, `transaction()` for the Effect client, and
 * `transactionSync()` committing when its closure returns and rolling back
 * when it throws. The database lives in a file, so closing it and opening the
 * same file again is a hibernated object waking with its disk.
 */
import { ShardProtocol } from "@smthrs/sync"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/sql/SqlClient"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DoSqliteShard } from "../src/index.ts"
import { openStorage } from "./SqliteObjectFixture.ts"

const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:acme/widgets")
const otherShard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:other")
const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)

const withObject = <A, E>(
  options: Partial<DoSqliteShard.Options> & { readonly path: string },
  body: Effect.Effect<A, E, DoSqliteShard.DoSqliteShard | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const object = openStorage(options.path)
    const result = yield* Effect.provide(body, DoSqliteShard.layer(object.storage, { shard, ...options }))
    return { result, object }
  })

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "do-sqlite-shard-"))
  return { path: join(dir, "object.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const command = (node: string, id: string, payload: DoSqliteShard.Json): DoSqliteShard.Command => ({
  key: [node, id],
  stream,
  payload
})

const submit = (cmd: DoSqliteShard.Command, epoch = 0) =>
  Effect.flatMap(DoSqliteShard.DoSqliteShard, (object) => object.submit({ version: 2, shard, epoch, command: cmd }))

const pull = (after: number, limit = 100, epoch = 0) =>
  Effect.flatMap(DoSqliteShard.DoSqliteShard, (object) => object.pull({ version: 2, shard, epoch, after, limit }))

describe("DoSqliteShard", () => {
  it.effect("builds the Effect client from { storage }, so its transactions work where BEGIN is refused", () => {
    const { path, cleanup } = scratch()
    return withObject(
      { path },
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        expect(SqliteClient.TypeId in sql).toBe(true)
        expect((sql as SqliteClient.SqliteClient).config.storage).toBeDefined()
        expect((sql as SqliteClient.SqliteClient).config.db).toBeUndefined()
        // A `{ db }` client would fail here: its withTransaction is unsupported.
        yield* sql.withTransaction(sql`SELECT 1`)
        yield* Effect.flip(sql`BEGIN IMMEDIATE`)
      })
    ).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })

  it.effect("rolls back a submit whose transaction faults before commit", () => {
    const { path, cleanup } = scratch()
    let fault = true
    return withObject(
      {
        path,
        beforeCommit: (entry) => {
          if (fault && entry.seq === 2) throw new Error("pre-commit fault")
        }
      },
      Effect.gen(function*() {
        yield* submit(command("a", "1", "one"))
        const failed = yield* Effect.exit(submit(command("a", "2", "two")))
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* (yield* DoSqliteShard.DoSqliteShard).head).toEqual({ shard, epoch: 0, seq: 1 })
        fault = false
        // Nothing of the failed submit survived: not its entry, not its receipt.
        expect(yield* submit(command("a", "2", "two"))).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      })
    ).pipe(
      Effect.tap(({ object }) =>
        Effect.sync(() => {
          expect(object.count("shard_entries")).toBe(2)
          expect(object.count("shard_receipts")).toBe(2)
        })
      ),
      Effect.ensuring(Effect.sync(cleanup))
    )
  })

  it.effect("reads legacy stream names and command keys from a parent-written SQLite file", () => {
    const { path, cleanup } = scratch()
    return Effect.gen(function*() {
      // Written by DoSqliteShard at 8c6700ac with its public submit API.
      copyFileSync(new URL("./fixtures/legacy-shard.sqlite", import.meta.url), path)
      const object = openStorage(path)
      yield* Effect.gen(function*() {
        const page = yield* pull(0)
        expect(page).toEqual({
          _tag: "Page",
          shard,
          epoch: 0,
          entries: [
            { seq: 1, epoch: 0, key: ["legacy-node", "0"], stream: "legacy/unscoped stream", events: [{ index: 0 }] },
            { seq: 2, epoch: 0, key: ["legacy-node", "1"], stream: "", events: [{ index: 1 }] },
            {
              seq: 3, epoch: 0, key: ["legacy-node", ""], stream: "",
              events: [{ legacy: ["legacy-node", ""] }]
            },
            {
              seq: 4, epoch: 0, key: ["", "legacy-command"], stream: "",
              events: [{ legacy: ["", "legacy-command"] }]
            }
          ],
          through: 4,
          head: 4,
          done: true
        })
        const wirePage: unknown = JSON.parse(JSON.stringify(page))
        expect(Schema.decodeUnknownSync(ShardProtocol.PullResponse)(wirePage)).toEqual(page)
        const newCommand = {
          version: 2,
          shard,
          epoch: 0,
          command: { key: ["new-node", "0"], stream: "legacy/unscoped stream", payload: null }
        }
        const journal = yield* DoSqliteShard.DoSqliteShard
        for (const invalid of [
          newCommand,
          { ...newCommand, command: command("", "0", null) },
          { ...newCommand, command: command("new-node", "", null) }
        ]) {
          expect(() => Schema.decodeUnknownSync(ShardProtocol.SubmitRequest)(invalid)).toThrow()
          expect(yield* Effect.flip(journal.submit(invalid as ShardProtocol.SubmitRequest)))
            .toMatchObject({ reason: "out_of_range" })
        }
        expect(yield* submit(command("new-node", "0", 5))).toMatchObject({
          _tag: "Accepted",
          position: { seq: 5 }
        })
      }).pipe(
        Effect.provide(DoSqliteShard.layer(object.storage, { shard })),
        Effect.ensuring(Effect.sync(object.hibernate))
      )
    }).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })

  it.effect("opens an existing unnamed shard for history but refuses new submits", () => {
    const { path, cleanup } = scratch()
    return Effect.gen(function*() {
      const fresh = openStorage(":memory:")
      const opening = yield* Effect.exit(Effect.provide(DoSqliteShard.DoSqliteShard, DoSqliteShard.layer(
        fresh.storage, { shard: "" }
      )).pipe(Effect.ensuring(Effect.sync(fresh.hibernate))))
      expect(Exit.isFailure(opening)).toBe(true)
      copyFileSync(new URL("./fixtures/legacy-shard.sqlite", import.meta.url), path)
      const object = openStorage(path)
      yield* Effect.gen(function*() {
        const journal = yield* DoSqliteShard.DoSqliteShard
        const request = yield* ShardProtocol.decodePullQuery(new URLSearchParams("v=2&shard=&epoch=0&after=0&limit=1"))
        const page = yield* journal.pull(request)
        expect(Schema.decodeUnknownSync(ShardProtocol.PullResponse)(JSON.parse(JSON.stringify(page)))).toEqual({
          _tag: "Page", shard: "", epoch: 0, entries: [
            { seq: 1, epoch: 0, key: ["", ""], stream: "", events: [{ legacy: ["", ""] }] }
          ], head: 1, through: 1, done: true
        })
        const snapshot = yield* journal.snapshot(request.shard)
        expect(Schema.decodeUnknownSync(ShardProtocol.SnapshotResponse)(snapshot)).toEqual({
          position: { shard: "", epoch: 0, seq: 0 }, state: null
        })
        const submit = { version: 2 as const, shard: request.shard, epoch: 0, command: command("new", "0", null) }
        expect(() => Schema.decodeUnknownSync(ShardProtocol.SubmitRequest)(submit)).toThrow()
        expect(yield* Effect.flip(journal.submit(submit))).toMatchObject({ reason: "out_of_range" })
        expect(yield* journal.head).toEqual({ shard: "", epoch: 0, seq: 1 })
      }).pipe(
        Effect.provide(DoSqliteShard.layer(object.storage, { shard: "" })),
        Effect.ensuring(Effect.sync(object.hibernate))
      )
    }).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })

  it.effect("writes no duplicate row when a command is replayed", () => {
    const { path, cleanup } = scratch()
    return withObject(
      {
        path,
        decide: (cmd) =>
          cmd.payload === "bad" ? { _tag: "Refused", reason: "bad" } : { _tag: "Accepted", events: [cmd.payload] }
      },
      Effect.gen(function*() {
        const first = yield* submit(command("a", "1", { n: 1, m: 2 }))
        for (let i = 0; i < 5; i++) {
          // Same content, keys in another order: the same command.
          expect(yield* submit(command("a", "1", { m: 2, n: 1 }))).toEqual({ ...first, _tag: "Duplicate" })
        }
        expect(yield* submit(command("a", "1", { n: 9 }))).toEqual({
          _tag: "IdempotencyConflict",
          shard,
          key: ["a", "1"],
          position: { shard, epoch: 0, seq: 1 }
        })
        expect(yield* submit(command("a", "2", "bad"))).toEqual({ _tag: "Refused", shard, key: ["a", "2"], reason: "bad" })
        // Every JSON shape hashes: null and arrays included.
        expect(yield* submit(command("a", "3", [null, { z: [true] }]))).toMatchObject({
          _tag: "Accepted",
          position: { seq: 2 }
        })
        expect(yield* submit(command("a", "3", [null, { z: [true] }]))).toMatchObject({
          _tag: "Duplicate",
          position: { seq: 2 }
        })
        expect(yield* submit(command("a", "2", "bad"))).toEqual({ _tag: "Refused", shard, key: ["a", "2"], reason: "bad" })
        expect(yield* submit(command("a", "2", "good"))).toEqual({
          _tag: "IdempotencyConflict",
          shard,
          key: ["a", "2"],
          position: null
        })
      })
    ).pipe(
      Effect.tap(({ object }) => Effect.sync(() => expect(object.count("shard_entries")).toBe(2))),
      Effect.ensuring(Effect.sync(cleanup))
    )
  })

  it.effect("keeps its order, receipts and a reader's cursor across hibernation", () => {
    const { path, cleanup } = scratch()
    return Effect.gen(function*() {
      const before = yield* withObject(
        { path },
        Effect.gen(function*() {
          for (const id of ["1", "2", "3"]) yield* submit(command("w", id, Number(id)))
          return yield* pull(0, 2)
        })
      )
      expect(before.result).toMatchObject({ _tag: "Page", through: 2, head: 3, done: false })
      const cursor = (before.result as { through: number }).through
      before.object.hibernate()

      const after = yield* withObject(
        { path },
        Effect.gen(function*() {
          const object = yield* DoSqliteShard.DoSqliteShard
          expect(yield* object.head).toEqual({ shard, epoch: 0, seq: 3 })
          expect(yield* submit(command("w", "2", 2))).toMatchObject({ _tag: "Duplicate", position: { seq: 2 } })
          expect(yield* submit(command("w", "4", 4))).toMatchObject({ _tag: "Accepted", position: { seq: 4 } })
          return yield* pull(cursor)
        })
      )
      expect(after.result).toEqual({
        _tag: "Page",
        shard,
        epoch: 0,
        entries: [
          { seq: 3, epoch: 0, key: ["w", "3"], stream, events: [3] },
          { seq: 4, epoch: 0, key: ["w", "4"], stream, events: [4] }
        ],
        through: 4,
        head: 4,
        done: true
      })
      expect(after.object.count("shard_entries")).toBe(4)
      after.object.hibernate()
    }).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })

  it.effect("persists a compacted snapshot and retains command receipts after restart", () => {
    const { path, cleanup } = scratch()
    return Effect.gen(function*() {
      const first = yield* withObject({ path }, Effect.gen(function*() {
        const object = yield* DoSqliteShard.DoSqliteShard
        yield* submit(command("a", "1", "first"))
        yield* submit(command("a", "2", "second"))
        expect(yield* Effect.flip(object.compact(3, null))).toMatchObject({ reason: "out_of_range" })
        expect(yield* object.compact(1, { value: "first" })).toEqual({ shard, epoch: 0, seq: 1 })
      }))
      expect(first.object.count("shard_entries")).toBe(1)
      first.object.hibernate()
      const second = yield* withObject({ path }, Effect.gen(function*() {
        const object = yield* DoSqliteShard.DoSqliteShard
        expect(yield* pull(0)).toEqual({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 1 })
        expect(yield* object.snapshot(shard)).toEqual({
          position: { shard, epoch: 0, seq: 1 },
          state: { value: "first" }
        })
        expect(yield* pull(1)).toMatchObject({ _tag: "Page", entries: [{ seq: 2 }], through: 2 })
        expect(yield* submit(command("a", "1", "first"))).toMatchObject({ _tag: "Duplicate", position: { seq: 1 } })
      }))
      second.object.hibernate()
    }).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })

  it.effect("fences an old epoch, resyncs a cursor it never issued, and refuses another shard", () => {
    const { path, cleanup } = scratch()
    return withObject(
      { path },
      Effect.gen(function*() {
        const object = yield* DoSqliteShard.DoSqliteShard
        yield* submit(command("a", "1", 1))
        expect(yield* pull(5)).toEqual({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 0 })
        expect(yield* object.advanceEpoch).toEqual({ shard, epoch: 1, seq: 1 })
        expect(yield* submit(command("a", "2", 2))).toEqual({ _tag: "StaleEpoch", key: ["a", "2"], shard, epoch: 1 })
        expect(yield* pull(1)).toEqual({ _tag: "Resync", shard, epoch: 1, snapshotSeq: 0 })
        expect(yield* object.snapshot(shard)).toEqual({ position: { shard, epoch: 1, seq: 0 }, state: null })
        expect(yield* submit(command("a", "2", 2), 1)).toMatchObject({
          _tag: "Accepted",
          position: { epoch: 1, seq: 2 }
        })
        for (
          const misrouted of [
            object.submit({ version: 2, shard: otherShard, epoch: 1, command: command("a", "3", 3) }),
            object.pull({ version: 2, shard: otherShard, epoch: 1, after: 0, limit: 1 }),
            object.snapshot(otherShard)
          ] as ReadonlyArray<Effect.Effect<unknown, unknown>>
        ) {
          expect(Exit.isFailure(yield* Effect.exit(misrouted))).toBe(true)
        }
      })
    ).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })
})
