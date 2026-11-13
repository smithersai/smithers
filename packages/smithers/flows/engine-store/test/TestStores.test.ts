/**
 * The engine composes the journal, the run store, and the step cache over one
 * database. This pins that the
 * bundle really is one database with one migrated schema.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as Consensus from "@smthrs/journal/Consensus"
import { Journal } from "@smthrs/journal/Journal"
import { type RunId, type SourceId } from "@smthrs/journal/JournalEvent"
import { AttemptStore } from "@smthrs/run-store/AttemptStore"
import { RunStore } from "@smthrs/run-store/RunStore"
import { CacheStore } from "@smthrs/step-cache/CacheStore"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as TestStores from "../src/test/TestStores.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { tempDirectory } from "./TempDirectory.ts"

describe("TestStores", () => {
  for (const named of [false, true]) {
    it.effect(`shares an explicitly selected consensus between run ownership and journal fencing: ${named}`, () => {
      const strategy = Consensus.layerLocal
      const options = { consensus: strategy }
      const bundle = named ? TestStores.layerAt(":memory:", options) : TestStores.layer(options)
      return Effect.gen(function*() {
        const owner = { hostId: "explicit", pid: 1, nonce: "explicit" }
        const runs = yield* RunStore
        yield* runs.create("explicit", "{}")
        expect(
          (yield* runs.claimAndOwn("explicit", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1))._tag
        ).toBe("Activated")
        // A concrete local strategy must hold the SAME lease the SQL-backed
        // run store claimed, rather than being shadowed by its default strategy.
        yield* (yield* Consensus.Consensus).guard("explicit", owner)
        const journal = yield* Journal
        const entry = {
          runId: "explicit" as RunId,
          sourceId: "explicit" as SourceId,
          eventType: "explicit",
          payload: {}
        }
        yield* journal.emitDurable(entry, owner)
        const refused = yield* Effect.flip(journal.emitDurable(entry, { ...owner, nonce: "wrong" }))
        expect(refused.code).toBe("fence_lost")
      }).pipe(
        Effect.provide(bundle.pipe(Layer.provideMerge(strategy))),
        Effect.provide(NodeCrypto.layer),
        Effect.scoped
      )
    })
  }

  it.effect("provides the complete production service bundle over in-memory SQLite", () =>
    Effect.gen(function*() {
      const owner = { hostId: "test-host", pid: 1, nonce: "bundle-owner" }
      const result = yield* (
        Effect.gen(function*() {
          const journal = yield* Journal
          const runs = yield* RunStore
          const attempts = yield* AttemptStore
          const cache = yield* CacheStore

          yield* runs.create("bundle-run", "{}")
          const pending = yield* runs.get("bundle-run")
          const snapshot = {
            status: pending.status,
            owner: pending.owner,
            heartbeatAtMs: pending.heartbeatAtMs
          }
          const claim = yield* runs.claim("bundle-run", snapshot, owner, 1)
          if (claim._tag !== "Claimed") {
            return yield* Effect.die(new Error("bundle run claim was lost"))
          }
          yield* runs.activate("bundle-run", owner, claim.claimedAtMs, snapshot)
          yield* attempts.put({
            runId: "bundle-run",
            stepKeyDigest: "bundle-step",
            attempt: 0,
            state: "running",
            startedAtMs: 1,
            meta: { poisonPill: false }
          }, owner)
          yield* attempts.finish({
            runId: "bundle-run",
            stepKeyDigest: "bundle-step",
            attempt: 0,
            state: "completed",
            finishedAtMs: 2,
            outcome: { value: "ok" }
          }, owner)
          yield* journal.emitDurable({
            runId: "bundle-run" as RunId,
            sourceId: "bundle" as SourceId,
            eventType: "step.completed",
            payload: { value: "ok" }
          }, owner)
          yield* journal.flush
          yield* cache.put({
            keyDigest: "bundle-cache",
            result: { value: "ok" },
            meta: {},
            createdAtMs: 2,
            recordedRunId: "bundle-run",
            recordedEventSeq: 0
          })

          return {
            attempt: yield* attempts.get({
              runId: "bundle-run",
              stepKeyDigest: "bundle-step",
              attempt: 0
            }),
            cache: yield* cache.get("bundle-cache"),
            entries: yield* journal.entries({
              runId: "bundle-run" as RunId,
              limit: 10
            })
          }
        }).pipe(
          Effect.provide(TestStores.layer({ capacity: 8 })),
          Effect.provide(NodeCrypto.layer),
          Effect.scoped
        )
      )

      expect(Option.getOrThrow(result.attempt).meta).toEqual({ poisonPill: false })
      expect(Option.getOrThrow(result.cache).result).toEqual({ value: "ok" })
      expect(result.entries.entries.map((entry) => entry.seq)).toEqual([0])
    }))
})

it.effect("reopens a named database with the same migrated state", () =>
  Effect.gen(function*() {
    expect.assertions(2)
    const directory = yield* tempDirectory("engine-store-reopen-")
    const filename = yield* PersistentDatabase.scoped(`${directory}/store.db`)
    const check = Effect.gen(function*() {
      const sql = yield* SqlClient
      return yield* sql<{ name: string }>`SELECT name FROM flows_migrations ORDER BY migration_id`
    }).pipe(Effect.provide(TestStores.databaseAt(filename)), Effect.scoped)
    const first = yield* check
    expect(first.length).toBeGreaterThan(0)
    expect(yield* check).toEqual(first)
  }).pipe(Effect.scoped))

it.skipIf(!process.env.SMITHERS_TEST_PG_URL)("uses the default schema for a PostgreSQL URL", async () => {
  const url = new URL(process.env.SMITHERS_TEST_PG_URL!)
  url.searchParams.delete("schema")
  const defaultSchema = await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient
      return yield* sql<{ schema: string }>`SELECT current_schema() AS schema`
    }).pipe(Effect.provide(TestStores.databaseAt(url.toString())))
  )
  expect(defaultSchema[0]?.schema).toBe("smithers_flows")
})

describe("storage matrix selection", () => {
  const postgresLeg = process.env.SMITHERS_TEST_PG_URL !== undefined
  /** Asks the server from a separate probe schema, which its own scope drops. */
  const schemaExists = (schema: string) =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      const rows = yield* sql<{ readonly name: string }>`
        SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name = ${schema}`
      return rows.length > 0
    }).pipe(
      Effect.provide(Layer.unwrap(Effect.map(TestStores.matrixAt("unused.db"), TestStores.databaseAt))),
      Effect.scoped
    )

  it.effect("matrixLayer runs on the leg's backend", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      expect(sql.onDialectOrElse({ pg: () => "postgres", orElse: () => "sqlite" })).toBe(
        postgresLeg ? "postgres" : "sqlite"
      )
      yield* (yield* RunStore).create("matrix-layer", "{}")
    }).pipe(Effect.provide(TestStores.matrixLayer()), Effect.provide(NodeCrypto.layer), Effect.scoped))

  it.effect("matrixAt names one persistent store per case and drops it with the scope", () =>
    Effect.gen(function*() {
      const sqlitePath = "/nonexistent/matrix-at.db"
      const opened = yield* Effect.scoped(Effect.gen(function*() {
        const filename = yield* TestStores.matrixAt(sqlitePath)
        if (!postgresLeg) return { filename, status: undefined }
        yield* Effect.scoped(
          Effect.flatMap(RunStore, (runs) => runs.create("matrix-at", "{}")).pipe(
            Effect.provide(TestStores.layerAt(filename))
          )
        )
        // A second, independent opening reaches the same rows.
        const row = yield* Effect.scoped(
          Effect.flatMap(RunStore, (runs) => runs.get("matrix-at")).pipe(
            Effect.provide(TestStores.layerAt(filename))
          )
        )
        return { filename, status: row.status }
      }))
      if (!postgresLeg) return expect(opened).toEqual({ filename: sqlitePath, status: undefined })
      expect(opened.status).toBe("pending")
      const schema = new URL(opened.filename).searchParams.get("schema")!
      expect(schema).toMatch(/^matrix_/)
      expect(yield* schemaExists(schema)).toBe(false)
    }).pipe(Effect.provide(NodeCrypto.layer)))
})
