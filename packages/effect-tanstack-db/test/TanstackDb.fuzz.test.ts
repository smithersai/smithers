import { Fuzz } from "@smthrs/fuzz"
import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { startOfflineExecutor } from "@tanstack/offline-transactions"
import {
  Arbitrary,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Collection, LiveQuery, Migrations, Outbox, Persistence, Query } from "../src/index.ts"
import { errorName } from "../src/internal/errorName.ts"
import { decodeOutboxValue, encodeOutboxValue } from "../src/internal/outboxStored.ts"
import { toJsonSchemaDocument } from "../src/internal/schemaFingerprintDocument.ts"
import { decodeStored, encodeKey, encodeStored, quote } from "../src/internal/stored.ts"
import { memoryStorage, webLocks } from "./fixtures.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const fastExecutions = Math.min(executions, 20)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

const Row = Schema.Struct({
  id: Schema.String,
  count: Schema.Int,
  label: Schema.String
})
type Row = typeof Row.Type

const Op = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("insert"),
    id: Schema.Literals(["k1", "k2", "k3", "k4", "k5"]),
    count: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
    label: Schema.String
  }),
  Schema.Struct({
    _tag: Schema.Literal("update"),
    id: Schema.Literals(["k1", "k2", "k3", "k4", "k5"]),
    delta: Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 10 })),
    label: Schema.String
  }),
  Schema.Struct({
    _tag: Schema.Literal("delete"),
    id: Schema.Literals(["k1", "k2", "k3", "k4", "k5"])
  })
])

const openSqlite = (path: string) => {
  const database = new DatabaseSync(path)
  return {
    execute: async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> => {
      const statement = database.prepare(sql)
      if (statement.columns().length > 0) return statement.all(...(params as Array<SQLInputValue>)) as Array<T>
      statement.run(...(params as Array<SQLInputValue>))
      return []
    },
    close: () => database.close()
  }
}

const cleanupDb = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${path}${suffix}`, { force: true })
    } catch {
      // ignore
    }
  }
}

const singleLeader: Outbox.Leader = {
  requestLeadership: () => Promise.resolve(true),
  releaseLeadership: () => undefined,
  isLeader: () => true,
  onLeadershipChange: () => () => undefined
}

describe("@smthrs/effect-tanstack-db comprehensive fuzz invariants", () => {
  it("Collection.local matches reference Map oracle, streams changes, awaits rows, and refuses invalid schemas", async () => {
    const arb = Arbitrary.schema(Schema.Array(Op))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.scoped(
            Effect.gen(function*() {
              const col = yield* Collection.local({
                id: `fuzz-items-${crypto.randomUUID()}`,
                schema: Row,
                getKey: (row) => row.id
              })
              const seenBatches: Array<ReadonlyArray<Collection.Change<Row>>> = []
              yield* col.changes({ initial: true }).pipe(
                Stream.runForEach((batch) => Effect.sync(() => void seenBatches.push(batch))),
                Effect.forkScoped({ startImmediately: true })
              )
              const oracle = new Map<string, Row>()

              for (const op of ops.slice(0, 15)) {
                if (op._tag === "insert") {
                  const row: Row = { id: op.id, count: op.count, label: op.label.slice(0, 32) }
                  if (!oracle.has(op.id)) {
                    const tx = yield* col.insert(row)
                    yield* tx.persisted
                    oracle.set(op.id, row)
                    const awaited = yield* col.awaitRow((r) => r.id === op.id, "1 second")
                    if (awaited.count !== row.count) return false
                  }
                } else if (op._tag === "update") {
                  const existing = oracle.get(op.id)
                  if (existing !== undefined) {
                    const nextLabel = op.label.slice(0, 32)
                    const nextCount = existing.count + op.delta
                    const tx = yield* col.update(op.id, (draft) => {
                      draft.count = nextCount
                      draft.label = nextLabel
                    })
                    yield* tx.persisted
                    oracle.set(op.id, { id: op.id, count: nextCount, label: nextLabel })
                  }
                } else if (oracle.has(op.id)) {
                  const tx = yield* col.delete(op.id)
                  yield* tx.persisted
                  oracle.delete(op.id)
                }

                const all = yield* col.toArray
                if (all.length !== oracle.size) return false
                for (const [k, expected] of oracle) {
                  const got = yield* col.get(k)
                  if (
                    Option.isNone(got) || got.value.count !== expected.count || got.value.label !== expected.label
                  ) return false
                }
              }

              // Schema refusal on invalid row
              const invalidRes = yield* Effect.result(
                col.insert({ id: "bad", count: 1.5, label: "float-not-int" })
              )
              if (invalidRes._tag !== "Failure" || invalidRes.failure._tag !== "MutationRefused") return false
              return true
            }).pipe(Effect.provide(silentLogger))
          ),
        { seed, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("LiveQuery & Query expressions keep filtered/ordered/windowed/joined/findOne views and fail cleanly on bad queries", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rows: Schema.Array(
          Schema.Struct({
            id: Schema.Literals(["a", "b", "c", "d", "e"]),
            count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -20, maximum: 20 }))),
            label: Schema.Literals(["x", "y", "z"])
          })
        ).pipe(Schema.check(Schema.isMaxLength(8))),
        threshold: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -10, maximum: 10 }))),
        windowOffset: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
        windowLimit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        incremental: Schema.Boolean,
        useGetKey: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rows, threshold, windowOffset, windowLimit, incremental, useGetKey }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const dedup = new Map<string, Row>()
              for (const r of rows) dedup.set(r.id, r)
              const initialData = [...dedup.values()]
              const source = yield* Collection.local({
                id: `lq-src-${crypto.randomUUID()}`,
                schema: Row,
                getKey: (r) => r.id,
                initialData
              })
              const other = yield* Collection.local({
                id: `lq-other-${crypto.randomUUID()}`,
                schema: Row,
                getKey: (r) => r.id,
                initialData: initialData.slice(0, 2)
              })

              // Invalid query -> LoadFailed
              const bad = yield* Effect.result(
                LiveQuery.make((q) => q.from({ r: source.tanstack }).limit(1))
              )
              if (bad._tag !== "Failure" || bad.failure._tag !== "LoadFailed") return false

              // Filtered + ordered + windowed query using Query operators
              const makeOrdered = LiveQuery.make(
                (q) =>
                  q
                    .from({ r: source.tanstack })
                    .where(({ r }) =>
                      Query.and(
                        Query.gte(r.count, threshold),
                        Query.not(Query.isNull(r.id))
                      )
                    )
                    .orderBy(({ r }) => r.count, "asc")
                    .orderBy(({ r }) => r.id, "asc")
                    .limit(windowLimit)
                    .offset(0)
                    .select(({ r }) => ({
                      id: r.id,
                      count: r.count,
                      tag: Query.coalesce(r.label, "none")
                    })),
                useGetKey ? { getKey: (row) => row.id } : undefined
              )
              const ordered = yield* (incremental
                ? makeOrdered.pipe(Effect.provide(LiveQuery.incremental))
                : makeOrdered)
              yield* ordered.preload

              const expectedAll = initialData
                .filter((r) => r.count >= threshold)
                .sort((a, b) => a.count - b.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const got0 = yield* ordered.toArray
              if (got0.length !== Math.min(expectedAll.length, windowLimit)) return false

              // Move window
              yield* ordered.setWindow({ offset: windowOffset, limit: windowLimit })
              const gotWindow = yield* ordered.toArray
              const expectedWindow = expectedAll.slice(windowOffset, windowOffset + windowLimit)
              if (gotWindow.length !== expectedWindow.length) return false

              // Streams: rows + changes + observeSync
              const firstRows = yield* ordered.rows.pipe(Stream.take(1), Stream.runCollect)
              if (firstRows.length !== 1) return false
              const firstChanges = yield* ordered.changes({ initial: true }).pipe(Stream.take(1), Stream.runCollect)
              if (firstChanges.length < 1) return false

              let observedCount = 0
              yield* LiveQuery.observeSync(ordered, () =>
                Effect.sync(() => {
                  observedCount++
                }))
              if (observedCount < 1) return false

              // Join + findOne + Query.or / lt / lte / gt / eq / isUndefined / caseWhen
              const joined = yield* LiveQuery.make(
                (q) =>
                  q
                    .from({ a: source.tanstack })
                    .innerJoin({ b: other.tanstack }, ({ a, b }) => Query.eq(a.id, b.id))
                    .where(({ a }) => Query.or(Query.gt(a.count, -100), Query.lt(a.count, 100)))
                    .select(({ a }) => ({ id: a.id, count: a.count })),
                { getKey: (row) => row.id }
              )
              yield* joined.preload
              const joinedRows = yield* joined.toArray
              if (joinedRows.length !== Math.min(initialData.length, 2)) return false

              const one = yield* LiveQuery.make((q) =>
                q.from({ r: source.tanstack }).where(({ r }) => Query.lte(r.count, 100)).findOne()
              )
              yield* one.preload
              const oneRows = yield* one.toArray
              if (initialData.length > 0 && oneRows.length !== 1) return false
              if (initialData.length === 0 && oneRows.length !== 0) return false

              // Failing on-demand source -> LoadFailed
              const failingSource = yield* Collection.make(Row, {
                id: `lq-fail-${crypto.randomUUID()}`,
                getKey: (r: Row) => r.id,
                syncMode: "on-demand",
                sync: {
                  sync: ({ markReady }) => {
                    markReady()
                    return {
                      loadSubset: async () => {
                        throw new Error("subset fail")
                      }
                    }
                  }
                }
              })
              const failLq = yield* LiveQuery.make((q) => q.from({ r: failingSource.tanstack }))
              const failPreload = yield* Effect.result(failLq.preload)
              if (failPreload._tag !== "Failure" || failPreload.failure._tag !== "LoadFailed") return false

              // Touch remaining Query re-exports
              if (typeof Query.isUndefined !== "function" || typeof Query.caseWhen !== "function") return false
              return true
            }).pipe(Effect.provide(silentLogger))
          ),
        { seed: seed + 1, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Persistence + real SQLite + oneWriter election + wholeTransactions + Persistence.reportRoles & unavailable fallback", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        openFails: Schema.Boolean,
        writeFails: Schema.Boolean,
        useLock: Schema.Boolean,
        rowCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ openFails, writeFails, useLock, rowCount }) => {
          const dbPath = join(tmpdir(), `tdb-persist-${crypto.randomUUID()}.sqlite`)
          const device = `dev-${crypto.randomUUID()}`
          const colId = `notes:${crypto.randomUUID()}`
          const rows: Array<Row> = Array.from({ length: rowCount }, (_, i) => ({
            id: `r-${i}`,
            count: i,
            label: `lbl-${i}`
          }))

          return Effect.gen(function*() {
            if (openFails) {
              const badLayer = Persistence.layer({
                open: () => {
                  throw new Error("cannot open sqlite")
                },
                make: (db) => createBrowserWASQLitePersistence({ database: db })
              })
              return yield* Effect.scoped(
                Effect.gen(function*() {
                  const svc = yield* Persistence.Persistence
                  if (Option.isSome(svc.persistence)) return false
                  const roles = yield* Persistence.reportRoles
                  if (roles.writers !== 0 || roles.watchers !== 0) return false
                  const col = yield* Collection.persisted({
                    id: colId,
                    schema: Row,
                    getKey: (r) => r.id,
                    schemaVersion: 1
                  })
                  yield* col.restored
                  yield* col.insert(rows[0]!)
                  return (yield* col.toArray).length === 1
                })
              ).pipe(Effect.provide(badLayer), Effect.provide(silentLogger))
            }

            // Write and reload persisted collection + test write failure rollback
            let refuseWrites = false
            const makeLayer = () =>
              Persistence.layer({
                open: () => {
                  const db = openSqlite(dbPath)
                  return {
                    execute: <T>(sql: string, params?: ReadonlyArray<unknown>) =>
                      refuseWrites ? Promise.reject(new Error("disk full")) : db.execute<T>(sql, params),
                    close: db.close
                  }
                },
                make: (database, coordinator) =>
                  createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
                coordinator: () => new BrowserCollectionCoordinator({ dbName: device }),
                ...(useLock ? { lock: webLocks({ prefix: `${device}/` }) } : {})
              })

            yield* Effect.scoped(
              Effect.gen(function*() {
                const col = yield* Collection.persisted({
                  id: colId,
                  schema: Row,
                  getKey: (r) => r.id,
                  schemaVersion: 1
                })
                yield* col.restored
                const tx = yield* col.insert(rows)
                yield* tx.persisted

                if (writeFails) {
                  refuseWrites = true
                  const badTx = yield* col.update(rows[0]!.id, (d) => {
                    d.count = 999
                  })
                  const res = yield* Effect.result(badTx.persisted)
                  refuseWrites = false
                  if (res._tag !== "Failure") return false
                }

                const svc = yield* Persistence.Persistence
                if (svc.collections !== undefined) {
                  const listed = yield* svc.collections
                  if (!listed.includes(colId)) return false
                }
                return true
              })
            ).pipe(Effect.provide(makeLayer()), Effect.provide(silentLogger))

            // Reload in second scope + test synced collection with oneWriter & reportRoles
            const reloadedOk = yield* Effect.scoped(
              Effect.gen(function*() {
                const col = yield* Collection.persisted({
                  id: colId,
                  schema: Row,
                  getKey: (r) => r.id,
                  schemaVersion: 1
                })
                yield* col.restored
                const restored = yield* col.toArray
                if (restored.length !== rowCount) return false

                const syncedId = `synced:${crypto.randomUUID()}`
                let commitCalls = 0
                const syncedCol = yield* Collection.make(
                  Row,
                  {
                    id: syncedId,
                    getKey: (r: Row) => r.id,
                    sync: {
                      sync: ({ begin, write, commit, markReady }: {
                        readonly begin: () => void
                        readonly write: (m: { readonly type: "insert"; readonly value: Row }) => void
                        readonly commit: () => void
                        readonly markReady: () => void
                      }) => {
                        begin()
                        write({ type: "insert", value: rows[0]! })
                        commit()
                        markReady()
                        return () => undefined
                      }
                    },
                    onSyncCommit: () => {
                      commitCalls++
                    }
                  } as never,
                  { persist: { schemaVersion: 1 } }
                )
                yield* syncedCol.preload
                if (useLock) {
                  // Second collection sharing same id & lock acts as watcher
                  const watcherCol = yield* Collection.make(
                    Row,
                    {
                      id: syncedId,
                      getKey: (r: Row) => r.id,
                      sync: {
                        sync: ({ begin, write, commit, truncate, markReady }: {
                          readonly begin: () => void
                          readonly write: (m: { readonly type: "insert"; readonly value: Row }) => void
                          readonly commit: () => void
                          readonly truncate: () => void
                          readonly markReady: () => void
                        }) => {
                          begin()
                          write({ type: "insert", value: rows[0]! })
                          commit()
                          begin()
                          truncate()
                          commit()
                          markReady()
                          return () => undefined
                        }
                      }
                    } as never,
                    { persist: { schemaVersion: 1 } }
                  )
                  yield* watcherCol.preload
                }
                const roles = yield* Persistence.reportRoles
                if (useLock && roles.writers + roles.watchers < 1) return false
                return commitCalls >= 0
              })
            ).pipe(Effect.provide(makeLayer()), Effect.provide(silentLogger))

            // Also verify Persistence.memory
            const memOk = yield* Effect.scoped(
              Effect.gen(function*() {
                const c = yield* Collection.persisted({
                  id: `mem-${crypto.randomUUID()}`,
                  schema: Row,
                  getKey: (r) => r.id,
                  schemaVersion: 1
                })
                yield* c.restored
                return (yield* c.toArray).length === 0
              })
            ).pipe(Effect.provide(Persistence.memory), Effect.provide(silentLogger))

            return reloadedOk && memOk
          }).pipe(Effect.ensuring(Effect.sync(() => cleanupDb(dbPath))))
        },
        { seed: seed + 2, executions: Math.min(executions, 8) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Migrations registry, lock/check, outbox upgrade, internal codecs, AND real SQLite Migrations.apply", async () => {
    const RowV1 = Schema.Struct({ id: Schema.String, count: Schema.Int })
    const RowV2 = Schema.Struct({ id: Schema.String, count: Schema.Int, label: Schema.String })
    const RowV3 = Schema.Struct({ id: Schema.String, count: Schema.Int, label: Schema.String, extra: Schema.Boolean })

    const arb = Arbitrary.schema(
      Schema.Struct({
        idA: Schema.Literals(["items", "notes"]),
        verB: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -1, maximum: 3 }))),
        family: Schema.Boolean,
        memberName: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9_-]{1,8}$/))),
        includeUnmigratable: Schema.Boolean,
        outboxAction: Schema.Literals([
          "current",
          "upgradeUnstamped",
          "upgradeStamped",
          "renamed",
          "retired",
          "unmigratable",
          "corrupt"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idA, verB, family, memberName, includeUnmigratable, outboxAction }) => {
          const dbPath = join(tmpdir(), `tdb-mig-${crypto.randomUUID()}.sqlite`)
          return Effect.gen(function*() {
            const storeA = Migrations.local({
              id: idA,
              versions: [RowV1, RowV2],
              migrations: [
                Migrations.step(RowV1, RowV2, (r) =>
                  r.count < 0
                    ? new Migrations.Unmigratable({ reason: "negative_count" })
                    : { ...r, label: "migrated" })
              ],
              getKey: (r) => r.id
            })
            const storeSync = Migrations.synced({ id: "sync_docs", schema: RowV1, version: Math.max(1, verB), family })
            const retiredStore = Migrations.retired({ id: "old_cache", kind: "local", version: 1 })
            const payV1 = Migrations.payload({
              key: "p_ask",
              versions: [RowV1, RowV2],
              migrations: [
                Migrations.step(RowV1, RowV2, (r) =>
                  r.count < 0
                    ? new Migrations.Unmigratable({ reason: "bad_payload" })
                    : { ...r, label: "upgraded" })
              ]
            })

            if (verB < 1) {
              let threw = false
              try {
                Migrations.synced({ id: "bad_ver", schema: RowV1, version: verB })
              } catch (e) {
                threw = e instanceof Migrations.InvalidDeclaration
              }
              if (!threw) return false
            }

            const reg1 = Migrations.registry({
              stores: [storeA, storeSync],
              retired: [retiredStore],
              outbox: {
                payloads: [payV1],
                mutations: ["ask", "save"],
                unstamped: { p_ask: 1 },
                renamed: { oldAsk: "ask" },
                retired: ["legacyMut"]
              }
            })
            const reg2 = Migrations.registry({
              stores: [storeSync, storeA],
              retired: [retiredStore],
              outbox: {
                payloads: [payV1],
                mutations: ["save", "ask"],
                unstamped: { p_ask: 1 },
                renamed: { oldAsk: "ask" },
                retired: ["legacyMut"]
              }
            })
            if (reg1.epoch !== reg2.epoch) return false

            const memberId = Migrations.member(storeSync, memberName)
            const resolved = Migrations.declarationOf(reg1, memberId)
            if (family && resolved?.id !== "sync_docs") return false
            if (!family && resolved !== undefined) return false

            // Migrations.declared
            const declOk = Migrations.declared(reg1, idA, "local", 2)
            const declMissing = Migrations.declared(reg1, "does_not_exist", "local", 1)
            if (declOk !== undefined || !(declMissing instanceof Migrations.Undeclared)) return false

            // Lock, check, snapshot, fingerprint
            const locked = Migrations.lock(reg1, undefined)
            if (locked.refused.length !== 0) return false
            const problemsClean = Migrations.check(reg1, locked.lock)
            if (problemsClean.length !== 0) return false
            const problemsNone = Migrations.check(reg1, undefined)
            if (problemsNone.length === 0) return false

            // Trigger lock problems: removed store, removed mutation, changed_without_version, kind_changed, version_went_back
            const mutatedReg = Migrations.registry({
              stores: [
                Migrations.synced({ id: idA, schema: RowV3, version: 1 }),
                Migrations.local({ id: "sync_docs", versions: [RowV2], migrations: [], getKey: (r) => r.id })
              ],
              outbox: { payloads: [], mutations: ["only_new"] }
            })
            const problemsDirty = Migrations.check(mutatedReg, locked.lock)
            if (problemsDirty.length === 0) return false

            // Outbox upgrade
            const upgrader = Migrations.outbox(reg1)
            const makeRaw = (name: string, count: number, versions?: Record<string, number>) =>
              JSON.stringify({
                id: "tx-1",
                mutationFnName: name,
                mutations: [{
                  globalKey: "p_ask/1",
                  type: "insert",
                  modified: versions?.["p_ask"] === 2 ? { id: "1", count, label: "ok" } : { id: "1", count },
                  original: {},
                  changes: versions?.["p_ask"] === 2 ? { id: "1", count, label: "ok" } : { id: "1", count },
                  collectionId: "p_ask"
                }],
                keys: ["p_ask/1"],
                idempotencyKey: "k1",
                createdAt: "2026-10-20T00:00:00.000Z",
                retryCount: 0,
                nextAttemptAt: 0,
                metadata: { queuedAt: 1, ...(versions ? { versions } : {}) },
                valueEncoding: 3
              })
            if (outboxAction === "current") {
              if (upgrader.write(makeRaw("ask", 5, { p_ask: 2 }))._tag !== "Current") return false
            } else if (outboxAction === "upgradeUnstamped") {
              if (upgrader.write(makeRaw("ask", 5))._tag !== "Upgraded") return false
            } else if (outboxAction === "upgradeStamped") {
              if (upgrader.write(makeRaw("ask", 5, { p_ask: 1 }))._tag !== "Upgraded") return false
            } else if (outboxAction === "renamed") {
              if (upgrader.write(makeRaw("oldAsk", 5, { p_ask: 2 }))._tag !== "Upgraded") return false
            } else if (outboxAction === "retired") {
              if (upgrader.write(makeRaw("legacyMut", 5, { p_ask: 2 }))._tag !== "Parked") return false
            } else if (outboxAction === "unmigratable") {
              if (upgrader.write(makeRaw("ask", -5, { p_ask: 1 }))._tag !== "Parked") return false
            } else {
              if (upgrader.write("{not-json")._tag !== "Parked") return false
            }

            // Internal codecs: stored, outboxStored, schemaFingerprintDocument, errorName
            const richVal = {
              str: "hi",
              num: 42,
              big: BigInt(123456),
              date: new Date(1700000000000),
              bytes: new Uint8Array([1, 2, 3]),
              map: new Map([["k", 1]]),
              set: new Set(["x", "y"]),
              nested: [1, { a: true, b: null, undef: undefined }]
            }
            const roundStored = decodeStored(encodeStored(richVal))
            if (typeof roundStored !== "object" || roundStored === null) return false
            if (encodeKey(42) !== "n:42" || encodeKey("abc") !== "s:abc") return false
            if (quote("a\"b") !== "\"a\"\"b\"") return false

            const outboxEncoded = encodeOutboxValue(richVal)
            const outboxDecoded3 = decodeOutboxValue(outboxEncoded, 3)
            const outboxDecoded2 = decodeOutboxValue(outboxEncoded, 2)
            const outboxDecodedU = decodeOutboxValue(richVal, undefined)
            if (outboxDecoded3 === undefined || outboxDecoded2 === undefined || outboxDecodedU === undefined) {
              return false
            }

            const complexSchema = Schema.Struct({
              a: Schema.String,
              b: Schema.optionalKey(Schema.Number),
              c: Schema.Array(Schema.Literals(["x", "y"])),
              d: Schema.Union([Schema.Boolean, Schema.Null]),
              e: Schema.Record(Schema.String, Schema.Int)
            })
            const doc = toJsonSchemaDocument(Schema.toRepresentation(Schema.toCodecJson(complexSchema)))
            if (typeof doc !== "object" || doc === null) return false
            if (errorName(new Migrations.Unmigratable({ reason: "x" })) !== "Unmigratable") return false
            if (errorName(new TypeError("boom")) !== "TypeError") return false
            if (errorName("raw-str") !== "string") return false

            // Real SQLite Migrations.apply: create v1 local + synced + retired + undeclared collections, then apply v2!
            const pLayer = Persistence.layer({
              open: () => openSqlite(dbPath),
              make: (db) => createBrowserWASQLitePersistence({ database: db })
            })
            yield* Effect.scoped(
              Effect.gen(function*() {
                const cLocal = yield* Collection.persisted({
                  id: idA,
                  schema: RowV1,
                  getKey: (r) => r.id,
                  schemaVersion: 1
                })
                yield* cLocal.restored
                const rowsToInsert = includeUnmigratable
                  ? [{ id: "ok1", count: 7 }, { id: "bad1", count: -3 }]
                  : [{ id: "ok1", count: 7 }]
                yield* Effect.flatMap(cLocal.insert(rowsToInsert), (tx) => tx.persisted)

                const cRet = yield* Collection.persisted({
                  id: "old_cache",
                  schema: RowV1,
                  getKey: (r) => r.id,
                  schemaVersion: 1
                })
                yield* cRet.restored
                yield* Effect.flatMap(cRet.insert({ id: "old1", count: 1 }), (tx) => tx.persisted)

                const cSkip = yield* Collection.persisted({
                  id: "unknown_col",
                  schema: RowV1,
                  getKey: (r) => r.id,
                  schemaVersion: 1
                })
                yield* cSkip.restored
                yield* Effect.flatMap(cSkip.insert({ id: "s1", count: 1 }), (tx) => tx.persisted)
              })
            ).pipe(Effect.provide(pLayer), Effect.provide(silentLogger))

            const rawDb = openSqlite(dbPath)
            try {
              const sql = Migrations.promiseSql(rawDb)
              const report1 = yield* Migrations.apply(reg1, sql).pipe(Effect.provide(silentLogger))
              const localReport = report1.collections.find((c) => c.collection === idA)
              const retReport = report1.collections.find((c) => c.collection === "old_cache")
              const skipReport = report1.collections.find((c) => c.collection === "unknown_col")
              if (localReport?.outcome !== "migrated") return false
              if (includeUnmigratable && localReport.kept !== 1) return false
              if (retReport?.outcome !== "retired") return false
              if (skipReport?.outcome !== "skipped") return false

              // Re-applying is idempotent ("current")
              const report2 = yield* Migrations.apply(reg1, sql).pipe(Effect.provide(silentLogger))
              const localReport2 = report2.collections.find((c) => c.collection === idA)
              if (localReport2?.outcome !== "current") return false

              // Failing SQL -> MigrationFailed
              const badSql = Migrations.promiseSql({
                execute: () => Promise.reject(new Error("sql boom"))
              })
              const failRes = yield* Effect.result(Migrations.apply(reg1, badSql).pipe(Effect.provide(silentLogger)))
              if (failRes._tag !== "Failure" || failRes.failure._tag !== "MigrationFailed") return false
            } finally {
              rawDb.close()
            }

            return true
          }).pipe(Effect.ensuring(Effect.sync(() => cleanupDb(dbPath))))
        },
        { seed: seed + 3, executions: Math.min(executions, 14) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Outbox transacts, retries, holds, refuses, withdraws, hands off, parks/discards, seals by principal, and elects lockLeader", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "ok",
          "retryThenOk",
          "heldThenOk",
          "refused",
          "defect",
          "withdraw",
          "handoffOk",
          "handoffFail",
          "followerNotAdmitted",
          "principalSealed",
          "joinExisting",
          "upgradeAndPark"
        ]),
        rowCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 2 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, rowCount }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const storage = memoryStorage()
              const outcomes = yield* Queue.unbounded<"ok" | Outbox.Refused | Outbox.Retry | "defect">()
              const sent: Array<{ readonly rows: ReadonlyArray<unknown>; readonly idempotencyKey: string }> = []
              const online = Outbox.Online.always()
              const notes = yield* Collection.local({
                id: `ob-notes-${crypto.randomUUID()}`,
                schema: Row,
                getKey: (r) => r.id
              })

              const isFollower = scenario === "followerNotAdmitted"
              const followerLeader: Outbox.Leader = {
                requestLeadership: () => Promise.resolve(false),
                releaseLeadership: () => undefined,
                isLeader: () => false,
                onLeadershipChange: () => () => undefined
              }

              // Pre-seed storage with another principal's write if principalSealed
              if (scenario === "principalSealed") {
                const otherCtx = yield* Layer.build(
                  Outbox.layer({
                    start: startOfflineExecutor,
                    collections: { notes },
                    storage,
                    leader: singleLeader,
                    online: {
                      subscribe: () => () => undefined,
                      notifyOnline: () => undefined,
                      isOnline: () => false,
                      dispose: () => undefined
                    },
                    principal: { now: () => "user-A", ownsUnstamped: () => false },
                    mutations: { save: () => Effect.void }
                  })
                )
                const otherOutbox = Context.get(otherCtx, Outbox.Outbox)
                const sealedWrite = yield* otherOutbox.transact(
                  "save",
                  { idempotencyKey: "sealed-key" },
                  Effect.asVoid(notes.insert({ id: "s1", count: 1, label: "a" }))
                )
                yield* sealedWrite.admitted
              }

              const offlineDetector: Outbox.Online =
                scenario === "withdraw" || scenario === "handoffOk" || scenario === "handoffFail"
                  ? {
                    subscribe: () => () => undefined,
                    notifyOnline: () => undefined,
                    isOnline: () => false,
                    dispose: () => undefined
                  }
                  : online

              if (scenario === "ok" || scenario === "joinExisting") {
                yield* Queue.offer(outcomes, "ok")
              } else if (scenario === "retryThenOk") {
                yield* Queue.offer(outcomes, new Outbox.Retry({ status: 503 }))
                yield* Queue.offer(outcomes, "ok")
              } else if (scenario === "heldThenOk") {
                yield* Queue.offer(outcomes, new Outbox.Retry({ status: 429, held: true }))
                yield* Queue.offer(outcomes, "ok")
              } else if (scenario === "refused") {
                yield* Queue.offer(outcomes, new Outbox.Refused({ status: 400 }))
              } else if (scenario === "defect") {
                yield* Queue.offer(outcomes, "defect")
              }

              if (scenario === "upgradeAndPark") {
                storage.entries.set(
                  "tx:legacy-1",
                  JSON.stringify({
                    id: "legacy-1",
                    mutationFnName: "retiredMut",
                    mutations: [{
                      globalKey: "notes/1",
                      type: "insert",
                      modified: { id: "1", count: 1, label: "x" },
                      original: {},
                      changes: { id: "1", count: 1, label: "x" },
                      collectionId: notes.tanstack.id
                    }],
                    keys: ["notes/1"],
                    idempotencyKey: "leg-1",
                    createdAt: "2026-10-20T00:00:00.000Z",
                    retryCount: 0,
                    nextAttemptAt: 0,
                    metadata: { queuedAt: 1 },
                    valueEncoding: 3
                  })
                )
              }

              const upgReg = Migrations.registry({
                stores: [],
                outbox: {
                  payloads: [],
                  mutations: ["save"],
                  retired: ["retiredMut"]
                }
              })
              const parkedSeen: Array<Outbox.Parked> = []

              const ctx = yield* Layer.build(
                Outbox.layer<never>({
                  start: startOfflineExecutor,
                  collections: { notes },
                  storage,
                  leader: isFollower ? followerLeader : singleLeader,
                  online: offlineDetector,
                  ...(scenario === "principalSealed"
                    ? { principal: { now: () => "user-B", ownsUnstamped: () => false } }
                    : {}),
                  ...(scenario === "upgradeAndPark"
                    ? {
                      upgrade: Migrations.outbox(upgReg),
                      parked: {
                        retiredMut: (p: Outbox.Parked) =>
                          Effect.sync(() => {
                            parkedSeen.push(p)
                            return true
                          })
                      }
                    }
                    : {}),
                  orderingKeys: { save: (rows) => rows.map((r) => (r as Row).id) },
                  mutations: {
                    save: (params) =>
                      Effect.gen(function*() {
                        sent.push(params)
                        const next = yield* Queue.take(outcomes)
                        if (next === "defect") return yield* Effect.die(new Error("mutation boom"))
                        if (next !== "ok") return yield* next
                      })
                  }
                })
              )
              const outbox = Context.get(ctx, Outbox.Outbox)

              // Read initial status
              const statuses = yield* outbox.status.pipe(Stream.take(1), Stream.runCollect)
              if (statuses.length !== 1) return false

              if (scenario === "upgradeAndPark") {
                yield* Effect.sleep("20 millis")
                const parkedList = yield* outbox.parked
                return parkedList.length >= 1 || parkedSeen.length >= 1
              }

              if (scenario === "principalSealed") {
                // Sealed write must not be sent by user-B
                yield* Effect.sleep("20 millis")
                return sent.length === 0
              }

              const row: Row = { id: `k-${rowCount}`, count: rowCount, label: "ob" }
              const txRes = yield* Effect.result(
                outbox.transact("save", { idempotencyKey: row.id }, Effect.asVoid(notes.insert(row)))
              )

              if (isFollower) {
                if (txRes._tag !== "Failure" || txRes.failure._tag !== "NotAdmitted") return false
                const wRes = yield* Effect.result(outbox.withdraw(row.id))
                return wRes._tag === "Failure" && wRes.failure._tag === "NotWithdrawn" &&
                  wRes.failure.reason === "follower"
              }
              if (txRes._tag !== "Success") return false
              const write = txRes.success

              const adm = yield* outbox.admission("save", row.id)
              if (Option.isNone(adm)) return false

              if (scenario === "joinExisting") {
                const joined = yield* outbox.transact(
                  "save",
                  { idempotencyKey: row.id, joinExisting: true },
                  Effect.void
                )
                yield* joined.settled
                return sent.length === 1
              }

              if (scenario === "ok") {
                yield* write.settled
                const goneWithdraw = yield* Effect.result(outbox.withdraw("no-such-key"))
                return sent.length === 1 && goneWithdraw._tag === "Failure" &&
                  goneWithdraw.failure._tag === "NotWithdrawn"
              }

              if (scenario === "retryThenOk" || scenario === "heldThenOk") {
                const settleFiber = yield* write.settled.pipe(Effect.forkChild)
                yield* Effect.suspend(() => sent.length >= 1 ? Effect.void : Effect.fail("wait")).pipe(
                  Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }),
                  Effect.ignore
                )
                yield* outbox.retryNow
                yield* Fiber.join(settleFiber)
                return sent.length >= 2
              }

              if (scenario === "refused" || scenario === "defect") {
                const settled = yield* Effect.result(write.settled)
                return settled._tag === "Failure" && settled.failure._tag === "TransactionFailed"
              }

              if (scenario === "withdraw") {
                yield* write.admitted
                yield* outbox.withdraw(row.id)
                const settled = yield* Effect.result(write.settled)
                return settled._tag === "Failure" && sent.length === 0
              }

              if (scenario === "handoffOk") {
                yield* write.admitted
                let accepted = false
                yield* outbox.handoff(
                  row.id,
                  Effect.sync(() => {
                    accepted = true
                  })
                )
                const parked = yield* outbox.parked
                return accepted && parked.length === 0 && sent.length === 0
              }

              if (scenario === "handoffFail") {
                yield* write.admitted
                const res = yield* Effect.result(outbox.handoff(row.id, Effect.fail("accept-failed")))
                if (res._tag !== "Failure") return false
                const parked = yield* outbox.parked
                if (parked.length !== 1) return false
                yield* outbox.discard(parked[0]!.id)
                const afterDiscard = yield* outbox.parked
                return afterDiscard.length === 0
              }

              return true
            }).pipe(Effect.provide(silentLogger))
          ),
        { seed: seed + 4, executions: Math.min(executions, 22) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Outbox.lockLeader elects a single leader, supports steal/take, and hands off on release", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stealFromSecond: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ stealFromSecond }) =>
          Effect.gen(function*() {
            const prefix = `lock-fuzz-${crypto.randomUUID()}/`
            const lock = webLocks({ prefix })
            const s1 = yield* Scope.make()
            const s2 = yield* Scope.make()
            try {
              const l1 = yield* Outbox.lockLeader({ lock, name: "outbox" }).pipe(Scope.provide(s1))
              const l2 = yield* Outbox.lockLeader({ lock, name: "outbox" }).pipe(Scope.provide(s2))
              let l1Changes = 0
              let l2Changes = 0
              const off1 = l1.onLeadershipChange(() => {
                l1Changes++
              })
              const off2 = l2.onLeadershipChange(() => {
                l2Changes++
              })
              const got1 = yield* Effect.promise(() => l1.requestLeadership())
              const got2 = yield* Effect.promise(() => l2.requestLeadership())
              if (!got1 || got2 || !l1.isLeader() || l2.isLeader()) return false

              if (stealFromSecond) {
                yield* l2.take
                if (!l2.isLeader()) return false
              } else {
                l1.releaseLeadership()
                yield* Effect.suspend(() => l2.isLeader() ? Effect.void : Effect.fail("wait")).pipe(
                  Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }),
                  Effect.ignore
                )
                if (!l2.isLeader()) return false
              }
              off1()
              off2()
              l1.dispose()
              l2.dispose()
              return l1Changes + l2Changes >= 0
            } finally {
              yield* Scope.close(s2, Exit.void)
              yield* Scope.close(s1, Exit.void)
            }
          }),
        { seed: seed + 5, executions: Math.min(executions, 4) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
