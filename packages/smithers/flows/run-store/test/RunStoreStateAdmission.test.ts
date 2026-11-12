import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import { RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>
) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )

/**
 * Counts the times `text` is parsed while `effect` runs. Admission parses a
 * state text before it walks it, so no parse means no walk. `JSON.parse` still
 * runs; the spy only observes it.
 */
const parsesOf = <A, E, R>(text: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.spyOn(JSON, "parse")),
    (spy) => Effect.map(effect, (value) => [value, spy.mock.calls.filter(([input]) => input === text).length] as const),
    (spy) => Effect.sync(() => spy.mockRestore())
  )

// The remembered texts outlive one store, so each case uses a text of its own.
const state = (name: string) =>
  JSON.stringify({ name, changes: Array.from({ length: 40 }, (_, id) => ({ id, status: "queued" })) })

describe("RunStore state admission", () => {
  it.effect("reads a written state any number of times without parsing it again", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const text = state("written-once")
      const [, writes] = yield* parsesOf(text, store.create("written-once", text))
      expect(writes).toBe(1)
      const [rows, reads] = yield* parsesOf(
        text,
        Effect.all([store.get("written-once"), store.latestRound("written-once"), store.lineage("written-once")])
      )
      expect(rows[0].stateJson).toBe(text)
      expect(rows[1].stateJson).toBe(text)
      expect(rows[2].map((row) => row.stateJson)).toEqual([text])
      expect(reads).toBe(0)
    })))

  it.effect("parses a state another writer stored on its first read only", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* SqlClient.SqlClient
      yield* store.create("foreign-write", "{}")
      const text = state("foreign-write")
      yield* sql`UPDATE flows_runs SET state_json = ${text} WHERE run_id = 'foreign-write'`
      const [first, firstParses] = yield* parsesOf(text, store.get("foreign-write"))
      const [second, secondParses] = yield* parsesOf(text, store.get("foreign-write"))
      expect([first.stateJson, second.stateJson]).toEqual([text, text])
      expect([firstParses, secondParses]).toEqual([1, 0])
    })))

  it.effect("refuses a stored state over the limits on every read, after admitting the row's earlier state", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* SqlClient.SqlClient
      const text = state("then-corrupted")
      yield* store.create("then-corrupted", text)
      expect((yield* store.get("then-corrupted")).stateJson).toBe(text)
      const tooDeep = "[".repeat(RunStoreLive.maximumRunJsonDepth + 2) +
        "]".repeat(RunStoreLive.maximumRunJsonDepth + 2)
      yield* sql`UPDATE flows_runs SET state_json = ${tooDeep} WHERE run_id = 'then-corrupted'`
      const reads: ReadonlyArray<Effect.Effect<unknown, RunStoreLive.RunStoreError>> = [
        store.get("then-corrupted"),
        store.latestRound("then-corrupted"),
        store.lineage("then-corrupted")
      ]
      for (const read of [...reads, ...reads]) {
        expect(yield* Effect.flip(read)).toMatchObject({ code: "decode_failed" })
      }
      yield* sql`UPDATE flows_runs SET state_json = ${text} WHERE run_id = 'then-corrupted'`
      expect((yield* store.get("then-corrupted")).stateJson).toBe(text)
      expect(yield* Effect.flip(store.create("never-admitted", tooDeep))).toMatchObject({ code: "invalid_run" })
    })))
})
