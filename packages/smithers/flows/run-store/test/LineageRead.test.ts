import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"
import { history, observedSql } from "./LineageReadFixture.ts"

describe("lineage metadata reads", () => {
  for (const ended of [10, 100]) {
    it.effect(`decodes no state or journal payload with ${ended} ended rounds and one open round`, () => {
      let decodedBytes = 0
      const layer = RunStore.layer.pipe(Layer.provideMerge(
        observedSql((bytes) => {
          decodedBytes += bytes
        }).pipe(
          Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
        )
      ))
      return Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* history(store, ended)
        decodedBytes = 0
        for (let read = 0; read < 3; read++) {
          const rows = yield* store.lineage("round-0", { includeState: false })
          expect(rows.map((row) => row.runId)).toEqual(
            Array.from({ length: ended + 1 }, (_, ordinal) => `round-${ordinal}`)
          )
          expect(rows.filter((row) => row.status === "pending").map((row) => row.runId)).toEqual([`round-${ended}`])
        }
        // This also counts cold reads: omitted payloads never reach a decoder.
        expect(decodedBytes).toBe(0)
        const full = yield* store.lineage("round-0")
        expect(full).toHaveLength(ended + 1)
        expect(decodedBytes).toBeGreaterThan(ended * 30_000)
      }).pipe(Effect.provide(layer))
    })
  }
})

const database = Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))
const plain = RunStore.layer.pipe(Layer.provideMerge(database))

describe("lineage metadata boundaries", () => {
  it.effect("preserves membership, order and metadata, omitting only state", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}")
      yield* store.create("next", "{\"value\":2}", { parentRunId: "root", lineageId: "root", roundOrdinal: 1 })
      yield* store.create("fork", "{}", { parentRunId: "root" })
      yield* store.requestCancel("next", 7)
      const full = yield* store.lineage("root")
      const metadata = full.map(({ stateJson: _, ...row }) => row)
      for (const id of ["root", "next"]) {
        const rows = yield* store.lineage(id, { includeState: false })
        expect(rows).toEqual(metadata)
        expect(rows.every((row) => Object.isFrozen(row) && !Object.hasOwn(row, "stateJson"))).toBe(true)
      }
      expect((yield* store.lineage("fork", { includeState: false })).map((row) => row.runId)).toEqual(["fork"])
      expect(yield* store.lineage("missing", { includeState: false })).toEqual([])
      expect(yield* Effect.flip(store.lineage("", { includeState: false }))).toMatchObject({ code: "invalid_run" })
    }).pipe(Effect.provide(plain)))

  it.effect("does not decode an omitted corrupt state, but full reads still reject it", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* store.create("root", "{}")
      const invalid = "[".repeat(RunStore.maximumRunJsonDepth + 2) + "]".repeat(RunStore.maximumRunJsonDepth + 2)
      yield* sql`UPDATE flows_runs SET state_json = ${invalid} WHERE run_id = 'root'`
      expect((yield* store.lineage("root", { includeState: false }))[0]?.runId).toBe("root")
      expect(yield* Effect.flip(store.lineage("root"))).toMatchObject({ code: "decode_failed" })
      expect(yield* Effect.flip(store.get("root"))).toMatchObject({ code: "decode_failed" })
      expect(yield* Effect.flip(store.create("invalid", invalid))).toMatchObject({ code: "invalid_run" })
    }).pipe(Effect.provide(plain)))

  it.effect("still validates stored metadata and ownership invariants", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* store.create("root", "{}")
      yield* TestDatabase.checks(sql, false)
      yield* sql`UPDATE flows_runs SET owner_host_id = 'partial' WHERE run_id = 'root'`
      const failure = yield* Effect.flip(store.lineage("root", { includeState: false }))
      expect(failure).toMatchObject({ method: "lineage", code: "decode_failed" })
      expect(JSON.stringify(failure.cause)).not.toContain("stateJson")
      yield* sql`UPDATE flows_runs SET owner_host_id = NULL, status = 'invalid' WHERE run_id = 'root'`
      expect(yield* Effect.flip(store.lineage("root", { includeState: false }))).toMatchObject({
        code: "decode_failed",
        cause: { stage: "row-schema" }
      })
      yield* sql`UPDATE flows_runs SET status = 'pending' WHERE run_id = 'root'`
      yield* TestDatabase.checks(sql, true)
    }).pipe(Effect.provide(plain)))
})

describe("lineage options boundary", () => {
  it.effect("refuses malformed options without reading accessors or executing SQL", () => {
    let queries = 0
    let accessors = 0
    const layer = RunStore.layer.pipe(Layer.provideMerge(
      observedSql(() => {
        queries++
      }).pipe(Layer.provideMerge(database))
    ))
    return Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}")
      queries = 0
      const accessor = Object.defineProperty({}, "includeState", {
        enumerable: true,
        get() {
          accessors++
          throw new Error("accessor must not run")
        }
      })
      const invalid: ReadonlyArray<unknown> = [
        accessor,
        Object.create({ includeState: false }),
        null,
        false,
        0,
        [],
        {},
        { includeState: true },
        { includeState: undefined },
        { includeState: "false" },
        { includeState: false, unexpected: 1 },
        Object.defineProperty({}, "includeState", { value: false })
      ]
      for (const options of invalid) {
        const read = store.lineage("root", options as { readonly includeState: false })
        expect(yield* Effect.flip(read)).toMatchObject({ method: "lineage", code: "invalid_run" })
      }
      expect(accessors).toBe(0)
      expect(queries).toBe(0)
      expect(yield* store.lineage("root", Object.assign(Object.create(null), { includeState: false })))
        .toHaveLength(1)
      expect(queries).toBeGreaterThan(0)
    }).pipe(Effect.provide(layer))
  })
})
