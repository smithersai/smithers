import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TimeTravel } from "../src/TimeTravel.ts"
import {
  jjInstalled,
  Journal,
  parkCompensableFlow,
  parkSealedFlow,
  runRealEngine,
  withRealFixture
} from "./RealTimeTravelHarness.ts"

interface JournalRow {
  readonly event_type: string
  readonly payload_json: string
  readonly run_id: string
  readonly seq: number
}

const tailOf = (rows: ReadonlyArray<JournalRow>, runId: string): number =>
  rows.filter((row) => row.run_id === runId).at(-1)!.seq

describe.skipIf(!jjInstalled)("real file-backed rewind", () => {
  // The finite budget covers real engine execution, jj child processes, and two complete SQLite/service lifetimes.
  it.effect(
    "rewinds parked durable flows at exact tail and frame zero without touching the parent workspace",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-rewind-", (fixture) =>
          Effect.gen(function*() {
            const note = join(fixture.repository, "note.txt")
            yield* Effect.promise(() => writeFile(note, "parent-stable\n"))

            const first = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-first",
              Effect.gen(function*() {
                yield* parkSealedFlow("tail-run", Effect.succeed("tail"))
                yield* parkSealedFlow("zero-run", Effect.succeed("zero"))
                const journal = yield* Journal.Journal
                yield* journal.flush
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const initialRows = yield* sql<JournalRow>`
              SELECT run_id, seq, event_type, payload_json
              FROM flows_journal_events
              WHERE run_id IN ('tail-run', 'zero-run')
              ORDER BY run_id, seq
            `
                const tailSeq = tailOf(initialRows, "tail-run")
                const zeroTailSeq = tailOf(initialRows, "zero-run")
                const timeTravel = yield* TimeTravel
                const beforeTail = yield* Effect.promise(() => readFile(note, "utf8"))
                const tail = yield* timeTravel.rewind({
                  runId: "tail-run",
                  // The frame's lineage comes from the constructor that mints it. Re-derived on
                  // 2026-09-01: `FlowEngine.Lineage` moved the root address from `<runId>/root`
                  // to a versioned encoded tuple, so the old literal named a lineage the engine
                  // no longer writes.
                  frame: { lineageId: FlowEngine.Lineage.root("tail-run"), seq: tailSeq }
                })
                const afterTail = yield* Effect.promise(() => readFile(note, "utf8"))
                const zero = yield* timeTravel.rewind({
                  runId: "zero-run",
                  frame: { lineageId: FlowEngine.Lineage.root("zero-run"), seq: 0 }
                })
                const afterZero = yield* Effect.promise(() => readFile(note, "utf8"))
                return { afterTail, afterZero, beforeTail, tail, tailSeq, zero, zeroTailSeq }
              })
            )

            expect(first.tail.archive.archived).toBe(0)
            expect(first.zero.archive.archived).toBe(first.zeroTailSeq)
            expect(first.beforeTail).toBe("parent-stable\n")
            expect(first.afterTail).toBe("parent-stable\n")
            expect(first.afterZero).toBe("parent-stable\n")
            expect(yield* Effect.promise(() => readFile(note, "utf8"))).toBe("parent-stable\n")

            const reopened = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-restarted",
              Effect.gen(function*() {
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const journal = yield* sql<
                  { readonly count: number; readonly maximum: number; readonly run_id: string }
                >`
              SELECT run_id, COUNT(*) AS count, MAX(seq) AS maximum
              FROM flows_journal_events
              WHERE run_id IN ('tail-run', 'zero-run')
              GROUP BY run_id ORDER BY run_id
            `
                const archive = yield* sql<{ readonly count: number; readonly run_id: string }>`
              SELECT run_id, COUNT(*) AS count
              FROM flows_time_travel_archive
              WHERE run_id IN ('tail-run', 'zero-run')
              GROUP BY run_id ORDER BY run_id
            `
                const audits = yield* sql<{ readonly run_id: string; readonly status: string }>`
              SELECT run_id, status
              FROM flows_time_travel_audits
              WHERE run_id IN ('tail-run', 'zero-run')
              ORDER BY run_id
            `
                const runs = yield* sql<{
                  readonly owner_host_id: string | null
                  readonly run_id: string
                  readonly status: string
                }>`
              SELECT run_id, status, owner_host_id
              FROM flows_runs
              WHERE run_id IN ('tail-run', 'zero-run')
              ORDER BY run_id
            `
                return { archive, audits, journal, runs }
              })
            )

            expect(reopened.journal).toEqual([
              { run_id: "tail-run", count: first.tailSeq + 1, maximum: first.tailSeq },
              { run_id: "zero-run", count: 1, maximum: 0 }
            ])
            expect(reopened.archive).toEqual([{ run_id: "zero-run", count: first.zeroTailSeq }])
            expect(reopened.audits).toEqual([
              { run_id: "tail-run", status: "completed" },
              { run_id: "zero-run", status: "completed" }
            ])
            expect(reopened.runs).toEqual([
              { run_id: "tail-run", status: "suspended", owner_host_id: null },
              { run_id: "zero-run", status: "suspended", owner_host_id: null }
            ])
          }))
      }),
    { timeout: 60_000 }
  )

  it.effect(
    "restores the real jj tree to the compensable action's anchored revision",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-tree-", (fixture) =>
          Effect.gen(function*() {
            const note = join(fixture.repository, "note.txt")
            yield* Effect.promise(() => writeFile(note, "anchored\n"))
            const result = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-tree",
              Effect.gen(function*() {
                yield* parkCompensableFlow(
                  "tree-run",
                  Effect.promise(() => writeFile(note, "effect-output\n")).pipe(Effect.as("tree"))
                )
                const journal = yield* Journal.Journal
                yield* journal.flush
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const rows = yield* sql<JournalRow>`
              SELECT run_id, seq, event_type, payload_json
              FROM flows_journal_events
              WHERE run_id = 'tree-run'
              ORDER BY seq
            `
                const anchor = rows.find((row) => {
                  if (row.event_type !== "flows.engine.snapshot-identified") return false
                  const payload = JSON.parse(row.payload_json) as { readonly snapshotId?: string }
                  return payload.snapshotId !== undefined
                })
                if (anchor === undefined) return yield* Effect.die(new Error("engine did not commit a jj anchor"))
                yield* Effect.promise(() => writeFile(note, "mutated-after-anchor\n"))
                const timeTravel = yield* TimeTravel
                const rewind = yield* timeTravel.rewind({
                  runId: "tree-run",
                  frame: { lineageId: FlowEngine.Lineage.root("tree-run"), seq: anchor.seq }
                })
                return { restored: yield* Effect.promise(() => readFile(note, "utf8")), rewind }
              })
            )

            expect.soft(result.rewind.assessments.some((assessment) => assessment.effect.tier === "compensable")).toBe(
              true
            )
            expect.soft(result.restored).toBe("anchored\n")
            expect.soft(yield* Effect.promise(() => readFile(note, "utf8"))).toBe("anchored\n")
          }))
      }),
    { timeout: 60_000 }
  )

  it.effect(
    "restores a bookmark moved during the run on a whole-repository rewind, leaving no attempt commits",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-whole-repo-", (fixture) =>
          Effect.gen(function*() {
            const jjText = (...args: ReadonlyArray<string>) =>
              execFileSync("jj", [...args], { cwd: fixture.repository, encoding: "utf8" })
            const note = join(fixture.repository, "note.txt")
            yield* Effect.promise(() => writeFile(note, "anchored\n"))
            jjText("bookmark", "create", "release", "-r", "@")
            const bookmarkBefore = jjText("log", "--no-graph", "-r", "release", "-T", "commit_id")
            const result = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-whole-repo",
              Effect.gen(function*() {
                yield* parkCompensableFlow(
                  "whole-repo-run",
                  Effect.sync(() => {
                    writeFileSync(note, "effect-output\n")
                    jjText("bookmark", "set", "release", "-r", "root()", "--allow-backwards")
                    return "moved"
                  })
                )
                const journal = yield* Journal.Journal
                yield* journal.flush
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const rows = yield* sql<JournalRow>`
              SELECT run_id, seq, event_type, payload_json
              FROM flows_journal_events
              WHERE run_id = 'whole-repo-run'
              ORDER BY seq
            `
                const anchor = rows.find((row) => {
                  if (row.event_type !== "flows.engine.snapshot-identified") return false
                  const payload = JSON.parse(row.payload_json) as { readonly snapshotId?: string }
                  return payload.snapshotId !== undefined
                })
                if (anchor === undefined) return yield* Effect.die(new Error("engine did not commit a jj anchor"))
                const payload = JSON.parse(anchor.payload_json) as {
                  readonly snapshotId: string
                  readonly operationId?: string
                }
                const movedTo = jjText("log", "--no-graph", "-r", "release", "-T", "commit_id")
                const timeTravel = yield* TimeTravel
                const rewind = yield* timeTravel.rewind({
                  runId: "whole-repo-run",
                  frame: { lineageId: FlowEngine.Lineage.root("whole-repo-run"), seq: anchor.seq }
                }, { wholeRepo: true })
                return { payload, movedTo, rewind }
              })
            )

            expect(result.payload.snapshotId).toMatch(/^[0-9a-f]{40}$/)
            expect(result.payload.operationId).toMatch(/^[0-9a-f]{128}$/)
            expect(result.movedTo).not.toBe(bookmarkBefore)
            expect(result.rewind.assessments.some((assessment) => assessment.effect.tier === "compensable")).toBe(
              true
            )
            expect(jjText("log", "--no-graph", "-r", "release", "-T", "commit_id")).toBe(bookmarkBefore)
            expect(yield* Effect.promise(() => readFile(note, "utf8"))).toBe("anchored\n")
            expect(jjText("log", "--no-graph", "-r", "all()", "-T", "description")).not.toContain("smithers action")
          }))
      }),
    { timeout: 60_000 }
  )

  it.effect(
    "refuses a whole-repository rewind to a frame that recorded no jj operation",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-no-operation-", (fixture) =>
          Effect.gen(function*() {
            const refusal = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-no-operation",
              Effect.gen(function*() {
                yield* parkCompensableFlow("no-operation-run")
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const journal = yield* Journal.Journal
                yield* journal.flush
                const timeTravel = yield* TimeTravel
                const rows = yield* sql<JournalRow>`
              SELECT run_id, seq, event_type, payload_json
              FROM flows_journal_events
              WHERE run_id = 'no-operation-run' AND event_type = 'flows.engine.snapshot-identified'
              ORDER BY seq
            `
                const seq = rows.find((row) => JSON.parse(row.payload_json).snapshotId !== undefined)!.seq
                // An anchor journaled before operations were recorded has none.
                yield* sql`UPDATE flows_journal_events
                  SET payload_json = json_remove(payload_json, '$.operationId')
                  WHERE run_id = 'no-operation-run'`
                return yield* Effect.flip(timeTravel.rewind({
                  runId: "no-operation-run",
                  frame: { lineageId: FlowEngine.Lineage.root("no-operation-run"), seq }
                }, { wholeRepo: true }))
              })
            )
            expect(refusal.code).toBe("irreversible")
            expect(JSON.stringify(refusal.cause)).toContain("The target frame has no recorded jj operation.")
          }))
      }),
    { timeout: 60_000 }
  )
})
