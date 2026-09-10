import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"

const layer = RunStore.layer.pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

describe("logical run rounds", () => {
  it.effect("rolls back earlier round requests when a later SQL update fails, then retries", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* store.create("root", "{}", { lineageId: "root", roundOrdinal: 0 })
      yield* store.create("next", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* sql`CREATE TRIGGER fail_lineage_cancel BEFORE UPDATE OF cancel_requested_at_ms ON flows_runs
        WHEN NEW.run_id = 'next' BEGIN SELECT RAISE(ABORT, 'synthetic cancellation failure'); END`
      const error = yield* Effect.flip(store.requestCancelLineage("root", 100))
      expect(error.code).toBe("constraint")
      expect((yield* store.get("root")).cancelRequestedAtMs).toBeNull()
      expect((yield* store.get("next")).cancelRequestedAtMs).toBeNull()
      yield* sql`DROP TRIGGER fail_lineage_cancel`
      expect(yield* store.requestCancelLineage("root", 200)).toEqual({ _tag: "CancelRequested", requestedAtMs: 200 })
      expect((yield* store.lineage("root")).map((row) => row.cancelRequestedAtMs)).toEqual([200, 200])
    }).pipe(Effect.provide(layer)))

  it.effect("validates logical read and cancellation inputs before mutating any row", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}")
      for (const value of ["", "\ud800", 1, null]) {
        expect((yield* Effect.flip(store.lineage(value as never))).code).toBe("invalid_run")
        expect((yield* Effect.flip(store.latestRound(value as never))).code).toBe("invalid_run")
        expect((yield* Effect.flip(store.requestCancelLineage(value as never, 100))).code).toBe("invalid_run")
      }
      for (const time of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect((yield* Effect.flip(store.requestCancelLineage("root", time))).code).toBe("invalid_run")
      }
      expect((yield* store.get("root")).cancelRequestedAtMs).toBeNull()
    }).pipe(Effect.provide(layer)))

  it.effect("a new request dominates an already-requested round without overwriting its time", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}", { lineageId: "root", roundOrdinal: 0 })
      yield* store.create("next", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* store.requestCancel("next", 100)
      expect(yield* store.requestCancelLineage("root", 200)).toEqual({ _tag: "CancelRequested", requestedAtMs: 200 })
      expect((yield* store.get("next")).cancelRequestedAtMs).toBe(100)
      expect((yield* store.get("root")).cancelRequestedAtMs).toBe(200)
    }).pipe(Effect.provide(layer)))

  it.effect("records a logical cancellation atomically without changing completed round history", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const owner = { hostId: "seed", pid: 1, nonce: "seed" }
      yield* store.create("root", "{}", { lineageId: "root", roundOrdinal: 0 })
      yield* store.claimAndOwn(
        "root",
        { status: "pending", owner: null, heartbeatAtMs: null },
        owner,
        yield* Clock.currentTimeMillis
      )
      yield* store.create("next", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* store.transitionOwned("root", owner, "completed", "{}")
      expect(yield* store.requestCancelLineage("root", 100)).toEqual({ _tag: "CancelRequested", requestedAtMs: 100 })
      expect(yield* store.requestCancelLineage("next", 200)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 100 })
      expect((yield* store.get("root")).cancelRequestedAtMs).toBeNull()
      expect((yield* store.get("root")).status).toBe("completed")
      expect((yield* store.get("next")).cancelRequestedAtMs).toBe(100)
      expect(yield* store.requestCancelLineage("missing", 300)).toEqual({ _tag: "NotFound" })
    }).pipe(Effect.provide(layer)))

  it.effect("resolves every round from any round, excluding fork ancestry and other lineages", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}") // A pre-lineage root is still round zero.
      yield* store.create("second", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* store.create("third", "{}", { lineageId: "root", roundOrdinal: 2, parentRunId: "second" })
      yield* store.create("fork", "{}", { parentRunId: "root", lineageId: "fork", roundOrdinal: 0 })
      yield* store.create("other", "{}")
      for (const id of ["root", "second", "third"]) {
        expect((yield* store.lineage(id)).map((row) => row.runId)).toEqual(["root", "second", "third"])
        expect((yield* store.latestRound(id)).runId).toBe("third")
      }
      expect((yield* store.lineage("fork")).map((row) => row.runId)).toEqual(["fork"])
      expect((yield* store.lineage("other")).map((row) => row.runId)).toEqual(["other"])
      expect(yield* store.lineage("missing")).toEqual([])
      expect((yield* store.latestRound("other")).runId).toBe("other")
      expect((yield* Effect.flip(store.latestRound("missing"))).code).toBe("not_found_row")
    }).pipe(Effect.provide(layer)))

  it.effect("excludes a same-named run that belongs to an independent lineage", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("shared-name", "{}", { lineageId: "independent-lineage", roundOrdinal: 0 })
      yield* store.create("target", "{}", { lineageId: "shared-name", roundOrdinal: 0 })
      expect((yield* store.lineage("target")).map((row) => row.runId)).toEqual(["target"])
      expect((yield* store.lineage("shared-name")).map((row) => row.runId)).toEqual(["shared-name"])
      expect(yield* store.requestCancelLineage("target", 100)).toEqual({ _tag: "CancelRequested", requestedAtMs: 100 })
      expect((yield* store.get("target")).cancelRequestedAtMs).toBe(100)
      expect((yield* store.get("shared-name")).cancelRequestedAtMs).toBeNull()
    }).pipe(Effect.provide(layer)))
})
