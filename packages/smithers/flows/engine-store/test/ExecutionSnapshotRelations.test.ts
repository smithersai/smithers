import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.vibe"
import { fixture, onFile, state } from "./ExecutionSnapshotFixture.ts"

describe("engine-only related execution catalog", () => {
  it.effect("pages durable children, missing edge targets and rounds without control admissions", () =>
    fixture((file) =>
      Effect.gen(function*() {
        yield* onFile(
          file,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            for (const id of ["root", "other", "child-a", "child-b"]) {
              yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${id}, 'pending', 1, ${state})`
            }
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, lineage_id, round_ordinal, parent_run_id)
        VALUES ('round-1', 'completed', 2, ${state}, 'root', 1, 'root'), ('round-2', 'pending', 3, ${state}, 'root', 2, 'round-1')`
            yield* sql`INSERT INTO flows_run_parents VALUES ('child-a', 'root', 1), ('child-b', 'root', 1), ('missing-child', 'root', 2), ('child-b', 'other', 3)`
          })
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const reader = yield* ExecutionSnapshot.make()
            const children = yield* reader.related({ runId: "root", kind: "children", limit: 1 })
            expect(children.anchor).toMatchObject({ _tag: "Observed", runId: "root", parentRunId: null })
            expect(children.snapshots.map((row) => row.runId)).toEqual(["child-a"])
            const next = yield* reader.related({ runId: "root", kind: "children", cursor: children.cursor!, limit: 2 })
            expect(next.snapshots.map((row) => row.runId)).toEqual(["child-b", "missing-child"])
            expect(next.snapshots[1]).toMatchObject({ _tag: "Missing", deleted: false })
            expect(next.cursor).toBeNull()
            const firstRound = yield* reader.related({ runId: "round-1", kind: "rounds", limit: 2 })
            expect(firstRound.snapshots.map((row) => row.runId)).toEqual(["root", "round-1"])
            const lastRound = yield* reader.related({ runId: "round-1", kind: "rounds", cursor: firstRound.cursor! })
            expect(lastRound.snapshots.map((row) => row.runId)).toEqual(["round-2"])
            expect(lastRound.cursor).toBeNull()
            expect((yield* reader.related({ runId: "unknown", kind: "rounds" })).anchor._tag).toBe("Missing")
            expect((yield* reader.related({ runId: "unknown", kind: "children" })).snapshots).toEqual([])
            for (
              const input of [
                { runId: "other", kind: "children", cursor: children.cursor! },
                { runId: "root", kind: "rounds", cursor: children.cursor! },
                {
                  runId: "root",
                  kind: "children",
                  cursor: JSON.stringify({ ...JSON.parse(children.cursor!), source: "0".repeat(32) })
                }
              ] as const
            ) expect((yield* Effect.flip(reader.related(input))).code).toBe("invalid_run")
            for (const limit of [0, 201]) {
              expect((yield* Effect.flip(reader.related({ runId: "root", kind: "children", limit }))).code).toBe(
                "decode_failed"
              )
            }
            for (const limit of [199, 200]) {
              expect((yield* reader.related({ runId: "root", kind: "children", limit })).snapshots).toHaveLength(3)
            }
            expect((yield* Effect.flip(reader.related({ runId: "root", kind: "children", cursor: "bad" }))).code).toBe(
              "decode_failed"
            )
            const sql = yield* SqlClient.SqlClient
            const before = (yield* reader.read(["child-a"])).snapshots[0]!
            yield* sql`UPDATE flows_run_parents SET parent_id = 'other' WHERE child_id = 'child-a'`
            const after = (yield* reader.read(["child-a"])).snapshots[0]!
            expect(after).toMatchObject({ parentRunId: "other" })
            expect(after.revision).toBeGreaterThan(before.revision)
            yield* sql`DELETE FROM flows_runs WHERE run_id = 'other'`
            expect((yield* reader.read(["child-a"])).snapshots[0]).toMatchObject({ parentRunId: null })
            expect(yield* sql`SELECT parent_id FROM flows_run_parents WHERE parent_id = 'other'`).toEqual([])
            expect((yield* reader.read(["child-a"])).revision).toBeGreaterThan(after.revision)
          })
        )
      })
    ))
})
