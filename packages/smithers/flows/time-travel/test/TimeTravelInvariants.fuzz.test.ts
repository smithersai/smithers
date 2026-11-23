import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Journal from "@smthrs/journal/Journal"
import type { Entry, RunId, Seq, SourceId, SourceSeq } from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { forkCreatedEventType } from "../src/Frame.ts"
import * as Replay from "../src/internal/Replay.ts"
import * as MemoryStore from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
const word = Schema.Literals(["λ", "a\u0000b", "../😀", "line\nend", ""])
const lineageId = "timeline/root"
const position = (runId: string, seq: number) => ({ runId, frame: { lineageId, seq } })
const fold = {
  initial: [] as Array<unknown>,
  reduce: (prefix: Array<unknown>, entry: Entry) => [...prefix, [entry.seq, entry.eventType, entry.payload]]
}
const history = Arbitrary.schema(Schema.Struct({
  values: Schema.Array(word).check(Schema.isMinLength(3), Schema.isMaxLength(9)),
  branch: offset,
  rewind: offset,
  operation: Schema.Literals(["rewind", "fork", "fork-and-rewind"]),
  page: offset
}))

const timelineLayer = (directory: string) => {
  const storage = Layer.provideMerge(
    DurableWriter.layer(),
    NodeDatabase.layer({ filename: join(directory, "timeline.sqlite") })
  )
  const stores = Layer.mergeAll(
    SqlJournal.layer({ capacity: 64, overflow: "reject" }),
    RunStore.layer,
    CacheStore.layer,
    SqlTimeTravelStore.layer,
    NodeJj.layerAt(join(directory, "repo"))
  )
    .pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, storage)))
  return TimeTravel.layer.pipe(Layer.provideMerge(stores))
}

interface ExpectedTimeline {
  readonly runId: string
  readonly rows: ReadonlyArray<unknown>
}

const checkTimeline = ({ runId, rows }: ExpectedTimeline) =>
  Effect.gen(function*() {
    const timeline = yield* TimeTravel
    expect(yield* timeline.replay(position(runId, rows.length - 1), fold, { pageSize: 1 })).toEqual(rows)
    expect((yield* Effect.flip(timeline.inspect(position(runId, rows.length), fold))).code).toBe("not_found")
  })

it("replays inclusive cursor prefixes across a real fork, parent rewind and SQLite reopen", async () => {
  const report = await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "timeline-fuzz-"))),
      (directory) =>
        Effect.gen(function*() {
          // Each example owns a distinct run tree. Reopen the database once and check every tree again.
          const saved: Array<ExpectedTimeline> = []
          let nextRun = 0
          yield* Effect.sync(() => execFileSync("jj", ["git", "init", join(directory, "repo")], { stdio: "ignore" }))
          const dir = join(directory, "forks")
          const result = yield* Fuzz.run(history, ({ values, branch, rewind, page, operation }) =>
            Effect.gen(function*() {
              const root = `timeline-${++nextRun}`
              const timeline = yield* TimeTravel
              const sql = yield* SqlClient.SqlClient
              const pageSize = page + 1
              const cut = operation === "fork" ? values.length - 1 : rewind % (values.length - 1)
              const forkAt = branch % (cut + 1)
              const rootRows = values.map((value, seq) => [seq, "step", { value }])
              yield* sql.withTransaction(Effect.gen(function*() {
                yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES (${root}, 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Timeline", payload: {} })})`
                for (const [seq, value] of values.entries()) {
                  yield* sql`INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES (${root}, ${seq}, ${`${root}-${seq}`}, 'timeline', ${seq}, ${seq}, 'step',
                ${JSON.stringify({ value })}, ${JSON.stringify({ lineageId })})`
                }
              }))
              for (const [seq] of values.entries()) {
                expect(yield* timeline.replay(position(root, seq), fold, { pageSize })).toEqual(
                  rootRows.slice(0, seq + 1)
                )
              }
              const before = yield* timeline.inspect(position(root, values.length - 1), fold)
              const bad = position(root, values.length + page)
              for (
                const refusal of [
                  Effect.flip(timeline.fork(bad, { workspaceRoot: dir })),
                  Effect.flip(timeline.rewind(bad)),
                  Effect.flip(timeline.replay(bad, fold))
                ]
              ) {
                expect((yield* refusal).code).toBe("not_found")
              }
              const created = operation === "rewind" ?
                undefined
                : yield* (yield* TimeTravelStore).createFork(root, { lineageId, seq: forkAt })
              expect(yield* timeline.inspect(position(root, values.length - 1), fold)).toEqual(before)
              if (operation !== "fork") {
                const restored = yield* timeline.rewind(position(root, cut), { pageSize })
                expect(restored.archive.archived).toBe(values.length - cut - 1)
              }
              expect(before).toEqual(rootRows)
              const expected: Array<ExpectedTimeline> = [{ runId: root, rows: rootRows.slice(0, cut + 1) }]
              if (created !== undefined) {
                expect(created.edge).toEqual({
                  parentRunId: root,
                  parentSeq: forkAt,
                  childRunId: created.runId,
                  kind: "fork",
                  attached: false
                })
                expected.push({
                  runId: created.runId,
                  rows: [...rootRows.slice(0, forkAt + 1), [forkAt + 1, forkCreatedEventType, {
                    parentRunId: root,
                    childRunId: created.runId,
                    forkJournalOffset: forkAt
                  }]]
                })
              }
              for (const tree of expected) {
                yield* checkTimeline(tree)
              }
              saved.push(...expected)
              return true
            }), { seed, executions: ioExecutions }).pipe(Effect.provide(timelineLayer(directory)), Effect.scoped)
          if (result._tag === "Passed") {
            yield* Effect.gen(function*() {
              for (const expected of saved) {
                yield* checkTimeline(expected)
              }
              // Materialize a surviving generated history as a jj workspace on the reopened host.
              const timeline = yield* TimeTravel
              const parent = saved[0]!
              const tail = parent.rows.length - 1
              const fork = yield* timeline.fork(position(parent.runId, tail), { workspaceRoot: dir })
              yield* checkTimeline({
                runId: fork.runId,
                rows: [...parent.rows, [tail + 1, forkCreatedEventType, {
                  parentRunId: parent.runId,
                  childRunId: fork.runId,
                  forkJournalOffset: tail
                }]]
              })
            }).pipe(Effect.provide(timelineLayer(directory)), Effect.scoped)
          }
          return result
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    )
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
})

const owner = { hostId: "host", pid: 1, nonce: "owner" }
const command = Schema.Struct({
  kind: Schema.Literals(["append", "rewind", "snapshot", "fork"]),
  lane: offset,
  cursor: offset,
  value: word
})

it("keeps per-branch history, copied snapshot anchors and archived generations independent", async () => {
  const report = await Effect.runPromise(
    Fuzz.run(
      Arbitrary.schema(Schema.Array(command).check(Schema.isMaxLength(12))),
      (commands) =>
        Effect.gen(function*() {
          const model = new Map<string, { rows: Array<unknown>; anchors: Map<number, string>; generation: number }>()
          model.set("root", { rows: [{ value: "root" }], anchors: new Map(), generation: 0 })
          const archive: Array<{ runId: string; seq: number; payload: unknown; generation: number }> = []
          const prefix = ["snapshot", "fork", "append", "rewind"] as const
          const script = [...prefix.map((kind) => ({ kind, lane: 0, cursor: 0, value: "prefix" })), ...commands]
          const store = MemoryStore.make({
            runOwners: new Map([["root", owner]]),
            records: [{ runId: "root", seq: 0, eventId: "root-0", lineageId, payload: { value: "root" } }]
          })
          for (const [index, op] of script.entries()) {
            const names = [...model.keys()]
            const runId = names[op.lane % names.length]!
            const branch = model.get(runId)!
            const seq = op.cursor % branch.rows.length
            const frame = { lineageId, seq }
            const priorWorld = store.state()
            const priorRecords = structuredClone(priorWorld.records)
            switch (op.kind) {
              case "append": {
                const payload = { value: op.value }
                store.append({ runId, seq: branch.rows.length, eventId: `row-${index}`, lineageId, payload })
                branch.rows.push({ ...payload })
                payload.value += "changed"
                break
              }
              case "snapshot": {
                const anchor = { runId, frame: { ...frame }, changeId: `anchor-${index}` }
                yield* store.recordSnapshot(anchor)
                branch.anchors.set(seq, anchor.changeId)
                anchor.frame.seq += 1
                const read = yield* store.snapshotAt(runId, frame)
                expect(read?.changeId).toBe(anchor.changeId)
                Object.assign(read!.frame, { seq: seq + 1 })
                break
              }
              case "fork": {
                const id = `branch-${index}`
                const result = yield* store.createFork(runId, frame, id)
                expect(result.edge).toEqual({
                  parentRunId: runId,
                  parentSeq: seq,
                  childRunId: id,
                  kind: "fork",
                  attached: false
                })
                model.set(id, {
                  rows: [...branch.rows.slice(0, seq + 1), {
                    parentRunId: runId,
                    forkJournalOffset: seq,
                    childRunId: id
                  }],
                  anchors: new Map([...branch.anchors].filter(([cursor]) => cursor <= seq)),
                  generation: 0
                })
                break
              }
              case "rewind": {
                // Only the root has a drive fence. A child cannot be truncated by its parent's owner.
                const truncate = store.archiveAndTruncate(runId, frame, [], owner)
                if (runId !== "root") {
                  expect((yield* Effect.flip(truncate)).code).toBe("fence_lost")
                  expect(store.state()).toEqual(priorWorld)
                  break
                }
                const removed = branch.rows.splice(seq + 1)
                expect((yield* truncate).archived).toBe(removed.length)
                for (const [i, payload] of removed.entries()) {
                  archive.push({ runId, seq: seq + 1 + i, payload, generation: branch.generation })
                }
                for (const cursor of branch.anchors.keys()) {
                  if (cursor > seq) {
                    branch.anchors.delete(cursor)
                  }
                }
                branch.generation++
                break
              }
            }
            expect(priorWorld.records).toEqual(priorRecords)
            const actual = store.state()
            for (const [id, lane] of model) {
              expect(actual.records.filter((record) => record.runId === id).map(({ seq, payload }) => [seq, payload]))
                .toEqual(lane.rows.map((payload, cursor) => [cursor, payload]))
              expect(
                actual.snapshots.filter((anchor) => anchor.runId === id).map((
                  { frame, changeId }
                ) => [frame.seq, changeId]).sort()
              )
                .toEqual([...lane.anchors].sort())
            }
            expect(actual.archived.map(({ runId, seq, payload, generation }) => ({ runId, seq, payload, generation })))
              .toEqual(archive)
          }
          return true
        }),
      { seed, executions: pureExecutions, execution: FuzzSimulation.execution() }
    )
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
})

const journalEntry = (seq: number, payload: string): Entry => ({
  runId: "root" as RunId,
  seq: seq as Seq,
  eventId: "first",
  sourceId: "writer" as SourceId,
  sourceSeq: 0 as SourceSeq,
  emittedAtMs: 1,
  eventType: "step",
  payload,
  meta: { lineageId }
})

const replayFrom = (journal: Journal.Service, seq: number) =>
  Replay.rederive({ lineageId, seq }, fold, { runId: "root", pageSize: 1 }).pipe(
    Effect.provideService(Journal.Journal, journal),
    Effect.provide(CacheStore.layerNoop())
  )

it("rejects a continuation that assigns two event identities to the same cursor", async () => {
  const report = await Effect.runPromise(
    Fuzz.run(Arbitrary.schema(Schema.Tuple([offset, word])), ([seq, value]) =>
      Effect.gen(function*() {
        const entry = journalEntry(seq, value)
        const corrupt = Journal.makeNoop({
          entries: ({ after }) =>
            Effect.succeed(
              after === undefined
                ? { entries: [entry], hasMore: true }
                : { entries: [{ ...entry, eventId: "second" }], hasMore: false }
            )
        })
        const error = yield* Effect.flip(replayFrom(corrupt, seq))
        expect(error).toMatchObject({ code: "invalid", cause: { runId: "root", seq, eventIds: ["first", "second"] } })
        return true
      }), { seed, executions: pureExecutions, execution: FuzzSimulation.execution() })
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
})

const invalidCursor = (kind: "negative" | "fraction" | "NaN" | "overflow", n: number) => {
  switch (kind) {
    case "negative":
      return -1 - n
    case "fraction":
      return n + 0.5
    case "NaN":
      return Number.NaN
    case "overflow":
      return Number.MAX_SAFE_INTEGER + n
  }
}

const malformedPage = (seq: number) =>
  Journal.makeNoop({
    entries: () => Effect.succeed({ entries: [journalEntry(seq, "")], hasMore: false })
  })

it("rejects non-journal coordinates before they can reach the fold or become a paging cursor", async () => {
  const input = Arbitrary.schema(Schema.Tuple([Schema.Literals(["negative", "fraction", "NaN", "overflow"]), offset]))
  const report = await Effect.runPromise(Fuzz.run(input, ([kind, n]) =>
    Effect.gen(function*() {
      const result = yield* Effect.result(replayFrom(malformedPage(invalidCursor(kind, n)), n + 1))
      expect(result).toMatchObject({ failure: { code: "invalid" } })
      return true
    }), { seed, executions: pureExecutions, execution: FuzzSimulation.execution() }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
})

// Seed 20261123 shrank to ["fraction", 0]: replay folded seq 0.5, then reported
// frame 1 as missing. A malformed page must be refused before the reduction.
it("rejects the shrunk fractional sequence 0.5 before projecting frame 1", async () => {
  let folded = 0
  const result = await Effect.runPromise(Effect.result(
    Replay.rederive({ lineageId, seq: 1 }, { initial: 0, reduce: () => ++folded }, { runId: "root" }).pipe(
      Effect.provideService(Journal.Journal, malformedPage(0.5)),
      Effect.provide(CacheStore.layerNoop())
    )
  ))
  expect(result).toMatchObject({ failure: { code: "invalid" } })
  expect(folded).toBe(0)
})
