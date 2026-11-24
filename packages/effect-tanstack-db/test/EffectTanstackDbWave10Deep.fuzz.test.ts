import { Fuzz } from "@smthrs/fuzz"
import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { startOfflineExecutor } from "@tanstack/offline-transactions"
import { Arbitrary, Context, Deferred, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { rmSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Collection from "../src/Collection.ts"
import { decodeStored, encodeKey, encodeStored } from "../src/internal/stored.ts"
import * as Migrations from "../src/Migrations.ts"
import * as Outbox from "../src/Outbox.ts"
import * as Persistence from "../src/Persistence.ts"
import { databaseFile, id, memoryStorage, Note, note, persistenceOn, sqlite, webLocks } from "./fixtures.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const V1 = Schema.Struct({ id: Schema.String, text: Schema.String })
const V2 = Schema.Struct({ id: Schema.String, text: Schema.String, v: Schema.Number })
const V3 = Schema.Struct({ id: Schema.String, text: Schema.String, v: Schema.Number, tag: Schema.String })

describe("@smthrs/effect-tanstack-db Wave10 Deep Fuzzing", () => {
  it(
    "fuzzes stored codec special numbers, escaped __type, schemaFingerprintDocument markers, and Persistence.collections errors",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          special: Schema.Literals(["nan", "pos_inf", "neg_inf", "escaped_type", "unknown_tag"]),
          tagVal: Schema.Literals(["Date", "custom", "BigInt"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ special, tagVal }) =>
            Effect.sync(() => {
              switch (special) {
                case "nan": {
                  const enc = encodeStored({ x: Number.NaN })
                  const dec = decodeStored(enc) as { x: number }
                  expect(Number.isNaN(dec.x)).toBe(true)
                  break
                }
                case "pos_inf": {
                  const dec = decodeStored(encodeStored({ x: Number.POSITIVE_INFINITY })) as { x: number }
                  expect(dec.x).toBe(Number.POSITIVE_INFINITY)
                  break
                }
                case "neg_inf": {
                  const dec = decodeStored(encodeStored({ x: Number.NEGATIVE_INFINITY })) as { x: number }
                  expect(dec.x).toBe(Number.NEGATIVE_INFINITY)
                  break
                }
                case "escaped_type": {
                  const orig = { __tanstack_db_persisted_type__: tagVal, val: 1 }
                  const dec = decodeStored(encodeStored(orig)) as Record<string, unknown>
                  expect(dec.__tanstack_db_persisted_type__).toBe(tagVal)
                  break
                }
                case "unknown_tag": {
                  expect(() =>
                    decodeStored(JSON.stringify({ __tanstack_db_persisted_type__: "FutureType", value: "abc" }))
                  ).toThrow(/unreadable stored value/)
                  break
                }
              }
              return true
            }),
          { executions: Math.min(executions, 60), seed }
        )
      )
      assertPassed(report)

      const MarkerSchema = Schema.Union([
        Schema.Literal("smithers/device/union-grouping"),
        Schema.Struct({
          nested: Schema.Array(Schema.String)
        })
      ])
      expect(Migrations.fingerprint(MarkerSchema).length).toBeGreaterThan(0)

      const noExecLayer = Persistence.layer({
        open: () => ({ close: () => undefined } as any),
        make: () => ({ adapter: {} as any })
      })
      const badRowLayer = Persistence.layer({
        open: () => ({
          execute: async () => [{ collection_id: 123 }],
          close: () => undefined
        }),
        make: () => ({ adapter: {} as any })
      })
      const throwLayer = Persistence.layer({
        open: () => ({
          execute: async () => {
            throw new Error("boom")
          },
          close: () => undefined
        }),
        make: () => ({ adapter: {} as any })
      })
      const layers: ReadonlyArray<Layer.Layer<Persistence.Persistence>> = [noExecLayer, badRowLayer, throwLayer]
      for (const layer of layers) {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function*() {
              const p = yield* Persistence.Persistence
              return yield* p.collections!
            }).pipe(Effect.provide(Layer.merge(layer, silentLogger)))
          )
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }
    },
    60_000
  )

  it(
    "fuzzes Migrations declarations, apply/prepare row error modes, outbox upgrade rejections, snapshot, and check",
    async () => {
      expect(() => Migrations.local({ id: "bad-empty", getKey: (r: any) => r.id, versions: [] as any })).toThrow()
      expect(() =>
        Migrations.local({
          id: "bad-count",
          getKey: (r: any) => r.id,
          versions: [V1, V2],
          migrations: []
        })
      ).toThrow()
      expect(() =>
        Migrations.local({
          id: "bad-pair",
          getKey: (r: any) => r.id,
          versions: [V1, V2],
          migrations: [Migrations.step(V2, V3, (r) => ({ ...r, tag: "x" })) as any]
        })
      ).toThrow()
      expect(() =>
        Migrations.local({
          id: "bad-first",
          first: 0,
          getKey: (r: any) => r.id,
          versions: [V1]
        })
      ).toThrow()

      const dupStore = Migrations.local({ id: "dup", getKey: (r) => r.id, versions: [V1] })
      expect(() => Migrations.registry({ stores: [dupStore, dupStore] })).toThrow()

      const p1 = Migrations.payload({ key: "p1", versions: [V1] })
      expect(() =>
        Migrations.registry({
          stores: [],
          outbox: { payloads: [p1, p1], mutations: ["m"] }
        })
      ).toThrow()
      expect(() =>
        Migrations.registry({
          stores: [],
          outbox: { payloads: [p1], mutations: ["m"], unstamped: { p1: 99 } }
        })
      ).toThrow()

      const toV2 = Migrations.step(V1, V2, (r) => {
        if (r.text === "defect") throw new Error("migration threw")
        if (r.text === "invalid") return { id: r.id, text: r.text, v: "not-a-number" as any }
        if (r.text === "wrong-key") return { id: "different-id", text: r.text, v: 2 }
        return { ...r, v: 2 }
      })
      const localKeep = Migrations.local({
        id: "keep_notes",
        getKey: (r) => r.id,
        versions: [V1, V2],
        migrations: [toV2]
      })
      const localDiscard = Migrations.local({
        id: "discard_notes",
        getKey: (r) => r.id,
        versions: [V1, V2],
        migrations: [toV2],
        discard: true
      })
      const syncedStore = Migrations.synced({ id: "synced_items", schema: V2, version: 2 })
      const reg = Migrations.registry({
        stores: [localKeep, localDiscard, syncedStore],
        outbox: {
          payloads: [
            Migrations.payload({ key: "keep_notes", versions: [V1, V2], migrations: [toV2] })
          ],
          mutations: ["save"],
          unstamped: { keep_notes: 1 },
          renamed: { old_save: "save" }
        }
      })

      const { lock: locked } = Migrations.lock(reg, undefined)
      const snap = Migrations.snapshot({
        stores: {
          ...locked.stores,
          vanished: { kind: "local", versions: { 1: "abc" } },
          old_retired: { kind: "local", retired: true, versions: { 1: "def" } }
        },
        payloads: locked.payloads,
        mutations: ["z", "a", "a"]
      })
      expect(snap.mutations).toEqual(["a", "z"])
      const problems = Migrations.check(reg, snap)
      expect(problems.some((p) => p.store === "vanished" && p.problem === "removed")).toBe(true)

      const dbPath = databaseFile()
      try {
        const db = sqlite(dbPath)
        const sql = Migrations.promiseSql(db)
        const prepared = Migrations.prepare(reg)

        const emptyReport = await Effect.runPromise(prepared.run(sql).pipe(Effect.provide(silentLogger)))
        expect(emptyReport.collections).toEqual([])

        await db.execute(`CREATE TABLE collection_registry (
        collection_id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`)
        await db.execute(
          `CREATE TABLE collection_version (collection_id TEXT PRIMARY KEY, latest_row_version INTEGER NOT NULL)`
        )
        await db.execute(
          `INSERT INTO collection_version VALUES ('keep_notes', 1), ('discard_notes', 1), ('synced_items', 1)`
        )
        await db.execute(`CREATE TABLE collection_expected_keys (collection_id TEXT NOT NULL, key TEXT NOT NULL)`)
        await db.execute(
          `CREATE TABLE t_keep (key TEXT PRIMARY KEY, value TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 0)`
        )
        await db.execute(
          `CREATE TABLE t_discard (key TEXT PRIMARY KEY, value TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 0)`
        )
        await db.execute(
          `CREATE TABLE t_synced (key TEXT PRIMARY KEY, value TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 0)`
        )
        await db.execute(
          `INSERT INTO collection_registry VALUES ('keep_notes', 't_keep', 1, 0), ('discard_notes', 't_discard', 1, 0), ('synced_items', 't_synced', 1, 0)`
        )
        await db.execute(`INSERT INTO t_keep (key, value) VALUES (?, ?)`, [encodeKey("bad-json"), "{not-json"])
        await db.execute(`INSERT INTO t_keep (key, value) VALUES (?, ?)`, [
          encodeKey("bad-decode"),
          encodeStored({ id: 123 })
        ])
        await db.execute(`INSERT INTO t_keep (key, value) VALUES (?, ?)`, [
          encodeKey("defect"),
          encodeStored({ id: "defect", text: "defect" })
        ])
        await db.execute(`INSERT INTO t_keep (key, value) VALUES (?, ?)`, [
          encodeKey("invalid"),
          encodeStored({ id: "invalid", text: "invalid" })
        ])
        await db.execute(`INSERT INTO t_keep (key, value) VALUES (?, ?)`, [
          encodeKey("wrong-key"),
          encodeStored({ id: "wrong-key", text: "wrong-key" })
        ])
        await db.execute(`INSERT INTO t_keep (key, value) VALUES (?, ?)`, [
          encodeKey("ok"),
          encodeStored({ id: "ok", text: "hello" })
        ])
        await db.execute(`INSERT INTO t_discard (key, value) VALUES (?, ?)`, [encodeKey("drop-me"), "{not-json"])

        const firstReport = await Effect.runPromise(prepared.run(sql).pipe(Effect.provide(silentLogger)))
        expect(firstReport.collections.find((c) => c.collection === "synced_items")?.outcome).toBe("resync")
        expect(firstReport.collections.find((c) => c.collection === "keep_notes")?.kept).toBe(5)
        expect(firstReport.collections.find((c) => c.collection === "discard_notes")?.dropped).toBe(1)

        const secondReport = await Effect.runPromise(prepared.run(sql).pipe(Effect.provide(silentLogger)))
        expect(secondReport.collections.find((c) => c.collection === "keep_notes")?.outcome).toBe("current")

        const failingSql: Migrations.Sql = {
          execute: (q) =>
            q.startsWith("SELECT name FROM sqlite_master")
              ? Effect.succeed([{ name: "collection_registry" }] as any)
              : q.includes("FROM collection_registry")
              ? Effect.succeed([{ collection_id: "keep_notes", table_name: "missing_tbl", schema_version: 1 }] as any)
              : q === "BEGIN IMMEDIATE" || q === "ROLLBACK"
              ? Effect.succeed([] as any)
              : Effect.fail(new Error("sql boom"))
        }
        const failApply = await Effect.runPromiseExit(
          Migrations.apply(reg, failingSql).pipe(Effect.provide(silentLogger))
        )
        expect(Exit.isFailure(failApply)).toBe(true)

        db.close()
      } finally {
        rmSync(dbPath, { force: true })
      }

      const up = Migrations.outbox(reg)
      const baseTx = (overrides: Record<string, unknown>) =>
        JSON.stringify({
          id: "tx-1",
          mutationFnName: "save",
          mutations: [],
          keys: ["keep_notes/1"],
          idempotencyKey: "k1",
          createdAt: "2026-10-20T00:00:00.000Z",
          retryCount: 0,
          nextAttemptAt: 0,
          metadata: { queuedAt: 1, versions: { keep_notes: 1 } },
          valueEncoding: 3,
          ...overrides
        })
      expect(up.write("null")._tag).toBe("Parked")
      expect(up.write(baseTx({ valueEncoding: 99 }))._tag).toBe("Parked")
      expect(
        up.write(
          baseTx({
            mutations: [{
              globalKey: "keep_notes/1",
              type: "update",
              modified: { __type: "Date", value: null },
              original: {},
              changes: {},
              collectionId: "keep_notes",
              key: "1"
            }]
          })
        )._tag
      ).toBe("Parked")
      expect(
        up.write(
          baseTx({
            mutations: [{
              globalKey: "unknown_col/1",
              type: "insert",
              modified: { id: "1", text: "a" },
              original: {},
              changes: {},
              collectionId: "unknown_col",
              key: "1"
            }]
          })
        )._tag
      ).toBe("Parked")
      expect(
        up.write(
          baseTx({
            metadata: { queuedAt: 1, versions: { keep_notes: 0 } },
            mutations: [{
              globalKey: "keep_notes/1",
              type: "insert",
              modified: { id: "1", text: "a" },
              original: {},
              changes: {},
              collectionId: "keep_notes",
              key: "1"
            }]
          })
        )._tag
      ).toBe("Parked")
      expect(
        up.write(
          baseTx({
            metadata: { queuedAt: 1, versions: { keep_notes: 99 } },
            mutations: [{
              globalKey: "keep_notes/1",
              type: "insert",
              modified: { id: "1", text: "a" },
              original: {},
              changes: {},
              collectionId: "keep_notes",
              key: "1"
            }]
          })
        )._tag
      ).toBe("Parked")
      const okUp = up.write(
        baseTx({
          mutationFnName: "old_save",
          mutations: [{
            globalKey: "keep_notes/1",
            type: "update",
            modified: { id: "1", text: "after" },
            original: { id: "1", text: "before" },
            changes: { text: "after" },
            collectionId: "keep_notes",
            key: "1"
          }]
        })
      )
      expect(okUp._tag).toBe("Upgraded")
      expect(
        up.write(
          baseTx({
            mutations: [{
              globalKey: "keep_notes/1",
              type: "update",
              modified: { id: "1", text: "after" },
              original: { id: "1", text: "defect" },
              changes: {},
              collectionId: "keep_notes",
              key: "1"
            }]
          })
        )._tag
      ).toBe("Parked")
      expect(
        up.write(
          baseTx({
            mutations: [{
              globalKey: "keep_notes/1",
              type: "update",
              modified: { id: "1", text: "after" },
              original: { id: 123 },
              changes: {},
              collectionId: "keep_notes",
              key: "1"
            }]
          })
        )._tag
      ).toBe("Parked")
    },
    60_000
  )

  it(
    "exercises Collection.make/persisted/local edge paths, pendingWrites, isSynced, delete, restore/write failures, and undeclared checks",
    async () => {
      const dbPath = databaseFile()
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const col = yield* Collection.make(
                Note,
                {
                  id: id("no-persist"),
                  getKey: (r) => r.id,
                  sync: {
                    sync: ({ begin, write, commit, markReady }) => {
                      begin()
                      write({ type: "insert", value: note("a", 1) })
                      commit()
                      markReady()
                    }
                  }
                },
                { persist: { schemaVersion: 1 } }
              )
              yield* col.preload
              expect(yield* col.isSynced("a")).toBe(true)
              expect((yield* col.pendingWrites("a")).length).toBe(0)
            }).pipe(Effect.provide(Layer.merge(Persistence.memory, silentLogger)))
          )
        )

        const emptyReg = Migrations.registry({ stores: [] })
        const regPersistLayer = Persistence.layer({
          open: () => sqlite(dbPath),
          make: (database, coordinator) =>
            createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
          registry: emptyReg
        })
        const undeclaredExit = await Effect.runPromiseExit(
          Effect.scoped(
            Collection.persisted({
              id: "not-in-registry",
              schema: Note,
              getKey: (r) => r.id,
              schemaVersion: 1
            }).pipe(Effect.provide(Layer.merge(regPersistLayer, silentLogger)))
          )
        )
        expect(Exit.isFailure(undeclaredExit)).toBe(true)

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const col = yield* Collection.persisted({
                id: id("crud"),
                schema: Note,
                getKey: (r) => r.id,
                schemaVersion: 1
              })
              yield* col.preload
              yield* col.insert(note("k1", 1))
              yield* col.update("k1", (d) => {
                d.n = 2
              })
              yield* col.delete("k1")
              expect(Option.isNone(yield* col.get("k1"))).toBe(true)
            }).pipe(Effect.provide(Layer.merge(persistenceOn(dbPath), silentLogger)))
          )
        )

        const failingPersistLayer = Persistence.layer({
          open: () => ({
            execute: async () => {
              throw new Error("disk boom")
            },
            close: () => undefined
          }),
          make: (database) => createBrowserWASQLitePersistence({ database })
        })
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const col = yield* Collection.persisted({
                id: id("fail-persist"),
                schema: Note,
                getKey: (r) => r.id,
                schemaVersion: 1
              })
              yield* Effect.exit(col.preload)
              const tx = yield* Effect.exit(col.insert(note("bad", 1)))
              if (Exit.isSuccess(tx)) {
                yield* Effect.sleep("20 millis")
              }
            }).pipe(Effect.provide(Layer.merge(failingPersistLayer, silentLogger)))
          )
        )
      } finally {
        rmSync(dbPath, { force: true })
      }
    },
    60_000
  )

  it(
    "fuzzes Outbox deep paths: admission migration, upgrades, parked/withdraw/discard, errors, defects, sealed, orderingKeys, bridge, and lockLeader",
    async () => {
      {
        const storage = memoryStorage()
        const key1 = "tx:legacy-1"
        const key2 = "tx:legacy-2"
        const keyOther = "tx:legacy-other"
        const makeLegacyRow = (txId: string, createdAt: string, extraMeta: Record<string, unknown> = {}) =>
          JSON.stringify({
            id: txId,
            mutationFnName: "save",
            mutations: [{
              globalKey: `notes/${txId}`,
              type: "insert",
              modified: { id: txId, text: "hi", n: 1 },
              original: {},
              changes: { id: txId, text: "hi", n: 1 },
              collectionId: "notes",
              key: txId
            }],
            keys: [`notes/${txId}`],
            idempotencyKey: txId,
            createdAt,
            retryCount: 0,
            nextAttemptAt: 0,
            metadata: { queuedAt: 1, ...extraMeta },
            valueEncoding: 3
          })
        storage.entries.set(
          key1,
          makeLegacyRow("legacy-1", "2026-10-20T00:00:00.000Z", { principal: "alice", held: true })
        )
        storage.entries.set(key2, makeLegacyRow("legacy-2", "2026-10-20T00:00:00.000Z", { principal: "alice" }))
        storage.entries.set(keyOther, makeLegacyRow("legacy-other", "2026-10-20T00:00:00.000Z", { principal: "bob" }))
        storage.entries.set("parked:bad", "{not-json")
        storage.entries.set(
          "parked:bob-1",
          JSON.stringify({
            reason: "withdrawn",
            name: "save",
            write: makeLegacyRow("bob-1", "2026-10-20T00:00:00.000Z", { principal: "bob" })
          })
        )
        storage.entries.set(
          "parked:alice-1",
          JSON.stringify({
            reason: "unmigratable",
            name: "save",
            write: makeLegacyRow("alice-1", "2026-10-20T00:00:00.000Z", { principal: "alice" })
          })
        )
        storage.entries.set(
          "parked:alice-2",
          JSON.stringify({
            reason: "withdrawn",
            name: "unhandled_fn",
            write: makeLegacyRow("alice-2", "2026-10-20T00:00:00.000Z", { principal: "alice" })
          })
        )

        let isLeader = true
        let changeListener: (() => void) | undefined
        const taken: Array<string> = []
        let capturedBridge: any

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const notes = yield* Collection.local({ id: "notes", schema: Note, getKey: (r) => r.id })
              const ctx = yield* Layer.build(
                Outbox.layer({
                  storage,
                  collections: { notes },
                  principal: { now: () => "alice", ownsUnstamped: () => false },
                  leader: {
                    requestLeadership: () => Promise.resolve(isLeader),
                    releaseLeadership: () => undefined,
                    isLeader: () => isLeader,
                    onLeadershipChange: () => () => undefined
                  },
                  online: { ...Outbox.Online.always(), isOnline: () => false },
                  changes: {
                    subscribe: (cb) => {
                      changeListener = cb
                      return () => {
                        changeListener = undefined
                      }
                    },
                    publish: () => {
                      throw new Error("notify failed")
                    }
                  },
                  upgrade: {
                    stamp: {},
                    write: (raw) => {
                      if (raw.includes("legacy-2")) return { _tag: "Upgraded", value: raw }
                      return { _tag: "Current" }
                    }
                  },
                  parked: {
                    save: (p) =>
                      Effect.sync(() => {
                        taken.push(p.id)
                        return true
                      })
                  },
                  orderingKeys: {
                    save: (rows) => rows.map((r: any) => String(r.id))
                  },
                  mutations: {
                    save: () => Effect.void
                  },
                  start: (cfg) => {
                    capturedBridge = cfg.storage
                    return startOfflineExecutor(cfg)
                  }
                })
              )
              const outbox = Context.get(ctx, Outbox.Outbox)
              yield* Effect.sleep("40 millis")

              changeListener?.()
              yield* Effect.sleep("20 millis")

              yield* outbox.discard("missing-id")
              yield* outbox.discard("bad")
              yield* outbox.discard("bob-1")
              yield* outbox.discard("alice-2")

              const bodyFail = yield* Effect.exit(
                outbox.transact(
                  "save",
                  { idempotencyKey: "fail-body" },
                  Effect.andThen(
                    notes.insert(note("fb", 1)),
                    Effect.fail(new Collection.MutationRefused({ operation: "insert", cause: "body-failed" }))
                  )
                )
              )
              expect(Exit.isFailure(bodyFail)).toBe(true)

              const w1 = yield* outbox.transact(
                "save",
                { idempotencyKey: "w1" },
                Effect.asVoid(notes.insert(note("w1", 1)))
              )
              yield* w1.admitted
              const w2 = yield* outbox.transact(
                "save",
                { idempotencyKey: "w2" },
                Effect.asVoid(notes.insert(note("w2", 2)))
              )
              yield* w2.admitted

              yield* outbox.handoff("w1", Effect.void)
              const goneExit = yield* Effect.exit(outbox.withdraw("no-such-key"))
              expect(Exit.isFailure(goneExit)).toBe(true)

              isLeader = false
              yield* Effect.promise(() =>
                capturedBridge.set(
                  "tx:new-not-leader",
                  makeLegacyRow("nl", "2026-10-20T00:00:00.000Z", { principal: "alice" })
                ).catch(() => undefined)
              )
              isLeader = true

              yield* Effect.promise(() => capturedBridge.delete(keyOther))
              expect(storage.entries.has(keyOther)).toBe(true)

              yield* Effect.promise(() => capturedBridge.clear())
              expect(storage.entries.size).toBe(0)
            }).pipe(Effect.provide(silentLogger))
          )
        )
        expect(taken).toContain("alice-1")
      }

      {
        const modeArb = Arbitrary.schema(Schema.Literals(["defect", "refused", "sent_elsewhere"]))
        const report = await Effect.runPromise(
          Fuzz.run(
            modeArb,
            (mode) =>
              Effect.scoped(
                Effect.gen(function*() {
                  const st = memoryStorage()
                  const notes = yield* Collection.local({ id: id("m"), schema: Note, getKey: (r) => r.id })
                  const ctx = yield* Layer.build(
                    Outbox.layer({
                      storage: st,
                      collections: { notes },
                      leader: {
                        requestLeadership: () => Promise.resolve(true),
                        releaseLeadership: () => undefined,
                        isLeader: () => true,
                        onLeadershipChange: () => () => undefined
                      },
                      online: Outbox.Online.always(),
                      mutations: {
                        run: () => {
                          if (mode === "defect") return Effect.die(new Error("boom-defect"))
                          if (mode === "refused") return Effect.fail(new Outbox.Refused({ status: 422 }))
                          for (const k of [...st.entries.keys()]) {
                            if (k.startsWith("tx:")) st.entries.delete(k)
                          }
                          return Effect.void
                        }
                      },
                      start: startOfflineExecutor
                    })
                  )
                  const outbox = Context.get(ctx, Outbox.Outbox)
                  const w = yield* outbox.transact(
                    "run",
                    { idempotencyKey: id("k") },
                    Effect.asVoid(notes.insert(note(id("n"), 1)))
                  )
                  yield* w.admitted
                  yield* Effect.sleep("25 millis")
                  return true
                }).pipe(Effect.provide(silentLogger))
              ),
            { executions: Math.min(executions, 9), seed }
          )
        )
        assertPassed(report)
      }

      {
        const lock = webLocks({ prefix: `${id("wl")}:` })
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const leader = yield* Outbox.lockLeader({ name: id("ll"), lock })
              const granted = yield* Effect.promise(() => leader.requestLeadership())
              expect(granted).toBe(true)
              expect(yield* Effect.promise(() => leader.requestLeadership())).toBe(true)
              yield* leader.take
              const val = yield* Effect.promise(() => leader.withAdmission!(async () => 42))
              expect(val).toBe(42)
              leader.releaseLeadership()
              yield* leader.take
              expect(leader.isLeader()).toBe(true)
            }).pipe(Effect.provide(silentLogger))
          )
        )

        const brokenLock: Outbox.Lock = {
          hold: () => Effect.die(new Error("lock refused")),
          tryHold: () => Effect.succeed(Option.none())
        }
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const leader = yield* Outbox.lockLeader({ name: id("broken"), lock: brokenLock })
              const granted = yield* Effect.promise(() => leader.requestLeadership())
              expect(granted).toBe(false)
            }).pipe(Effect.provide(silentLogger))
          )
        )

        const lostGate = await Effect.runPromise(Deferred.make<void>())
        let holds = 0
        const losingLock: Outbox.Lock = {
          hold: () =>
            Effect.sync(() => {
              holds += 1
              return { lost: holds === 1 ? Deferred.await(lostGate) : Effect.never }
            }),
          tryHold: () =>
            Effect.sync(() => {
              holds += 1
              return Option.some({ lost: Deferred.await(lostGate) })
            })
        }
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const leader = yield* Outbox.lockLeader({ name: id("losing"), lock: losingLock })
              expect(yield* Effect.promise(() => leader.requestLeadership())).toBe(true)
              yield* Deferred.succeed(lostGate, undefined)
              yield* Effect.sleep("25 millis")
              expect(holds).toBeGreaterThanOrEqual(2)
            }).pipe(Effect.provide(silentLogger))
          )
        )
      }

      {
        const badCounterStorage = memoryStorage()
        badCounterStorage.entries.set("outbox:admission-counter", "not-a-number")
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const notes = yield* Collection.local({ id: id("bc"), schema: Note, getKey: (r) => r.id })
              const ctx = yield* Layer.build(
                Outbox.layer({
                  storage: badCounterStorage,
                  collections: { notes },
                  leader: {
                    requestLeadership: () => Promise.resolve(true),
                    releaseLeadership: () => undefined,
                    isLeader: () => true,
                    onLeadershipChange: () => () => undefined
                  },
                  online: Outbox.Online.always(),
                  mutations: { save: () => Effect.void },
                  start: startOfflineExecutor
                })
              )
              const outbox = Context.get(ctx, Outbox.Outbox)
              const res = yield* Effect.exit(
                outbox.transact("save", { idempotencyKey: "k1" }, Effect.asVoid(notes.insert(note("1", 1))))
              )
              expect(Exit.isFailure(res)).toBe(true)
            }).pipe(Effect.provide(silentLogger))
          )
        )
      }
    },
    60_000
  )
})
