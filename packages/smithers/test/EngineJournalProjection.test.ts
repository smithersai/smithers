import { NodeCrypto } from "@effect/platform-node"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { CallFact } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Context, Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/internal/EngineJournalProjection.ts"

const setup = Effect.gen(function*() {
  const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const engineJournal = Context.get(native, Journal.Journal)
  const controlJournal = Context.get(control, Journal.Journal)
  const engineState = Context.get(native, DurableEngineState.DurableEngineState)
  return {
    native,
    engineJournal,
    controlJournal,
    engineState,
    runs: Context.get(native, RunStore.RunStore),
    sql: Context.get(native, SqlClient.SqlClient),
    options: { engineJournal, controlJournal, engineState, controlRunId: "control-root", executionId: "native-root" }
  }
}).pipe(Effect.provide(NodeCrypto.layer))

const emit = (journal: Journal.Service, runId: string, payload: unknown, sourceId = "fixture", sourceSeq = 0) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: runId as JournalEvent.RunId,
      sourceId: sourceId as JournalEvent.SourceId,
      sourceSeq: sourceSeq as JournalEvent.SourceSeq,
      eventType: "flows.engine.attempt-finished",
      payload,
      meta: { lineageId: "native-lineage" }
    })
  )

const rows = (journal: Journal.Service) =>
  Effect.map(
    journal.entries({ runId: "control-root" as JournalEvent.RunId, limit: 1000 }),
    (page) => page.entries.filter((entry) => entry.eventType !== "control.engine.bound")
  )
const record = (entry: JournalEvent.Entry) => entry.payload as Record<string, unknown>

// Count calls at execution time while delegating to the production services.
const counted = (f: Effect.Success<typeof setup>) => {
  const reads = { entries: [] as Array<string>, generations: [] as Array<string>, heads: 0, children: 0 }
  const engineJournal: Journal.Service = {
    ...f.engineJournal,
    entries: (options) =>
      Effect.suspend(() => {
        reads.entries.push(options.runId)
        return f.engineJournal.entries(options)
      }),
    generation: (runId) =>
      Effect.suspend(() => {
        reads.generations.push(runId)
        return f.engineJournal.generation!(runId)
      }),
    ...(f.engineJournal.heads === undefined ? {} : {
      heads: (ids: ReadonlyArray<JournalEvent.RunId>) =>
        Effect.suspend(() => {
          reads.heads++
          return f.engineJournal.heads!(ids)
        })
    })
  }
  const engineState = {
    ...f.engineState,
    ...(f.engineState.runChildrenOf === undefined ? {} : {
      runChildrenOf: (ids: ReadonlyArray<string>) =>
        Effect.suspend(() => {
          reads.children++
          return f.engineState.runChildrenOf!(ids)
        })
    })
  }
  return {
    reads,
    options: { ...f.options, engineJournal, engineState },
    reset: () => {
      reads.entries.length = 0
      reads.generations.length = 0
      reads.heads = 0
      reads.children = 0
    }
  }
}

const stateJson = JSON.stringify({ version: 1, flowName: "fixture", payload: {} })
const roundsFixture = (f: Effect.Success<typeof setup>, count: number) =>
  Effect.gen(function*() {
    yield* f.runs.create("native-root", stateJson)
    yield* emit(f.engineJournal, "native-root", { round: 0 })
    for (let round = 1; round <= count; round++) {
      yield* f.runs.create(`round-${round}`, stateJson, {
        lineageId: "native-root",
        roundOrdinal: round,
        parentRunId: "native-root"
      })
      yield* emit(f.engineJournal, `round-${round}`, { round })
    }
  })

describe("private engine journal projection", () => {
  it.each(["foreign", "repeated", "empty-continuing"] as const)(
    "refuses a faulty adapter's %s journal page",
    (fault) =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        if (fault !== "empty-continuing") yield* emit(f.engineJournal, "native-root", { real: true })
        const projector = yield* Projection.make({
          ...f.options,
          engineJournal: {
            ...f.engineJournal,
            heads: undefined,
            entries: (options) =>
              Effect.map(f.engineJournal.entries(options), (page) => ({
                ...page,
                entries: fault === "foreign" ?
                  page.entries.map((entry) => ({ ...entry, runId: "foreign" as JournalEvent.RunId }))
                  : fault === "repeated"
                  ? [...page.entries, ...page.entries]
                  : [],
                hasMore: fault === "empty-continuing"
              }))
          }
        })
        expect(yield* Effect.result(projector.catchUp)).toMatchObject({
          _tag: "Failure",
          failure: {
            code: "decode_failed",
            message: fault === "empty-continuing"
              ? "Engine projection received an empty continuing page"
              : "Engine projection received an unordered or foreign journal page"
          }
        })
        expect(yield* rows(f.controlJournal)).toHaveLength(fault === "repeated" ? 1 : 0)
      })))
  )

  it("refuses settling when a legacy status reader fails instead of reporting a missing row", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const projector = yield* Projection.make(f.options)
      const refusal = new RunStore.RunStoreError({
        code: "invalid_run",
        method: "get",
        message: "unreadable status",
        cause: null
      })
      expect(yield* Effect.result(projector.followUntilSettled({ get: () => Effect.fail(refusal) }))).toMatchObject({
        _tag: "Failure",
        failure: refusal
      })
    }))))

  it("preserves a diamond whose shared child precedes its second parent in traversal", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* f.engineState.recordRunParent("shared", "native-root")
      yield* f.engineState.recordRunParent("parent", "native-root")
      yield* f.engineState.recordRunParent("shared", "parent")
      for (const id of ["native-root", "shared", "parent"]) yield* emit(f.engineJournal, id, { id })
      const projector = yield* Projection.make(f.options)
      expect([...(yield* projector.catchUp)]).toEqual(["native-root", "shared", "parent"])
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).executionId)).toEqual([
        "native-root",
        "shared",
        "parent"
      ])
    }))))

  it("refuses an old root readiness callback when its drain crosses a rewind", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* f.runs.create("native-root", stateJson)
      yield* f.runs.create("detached", stateJson)
      yield* f.engineState.recordRunParent("detached", "native-root")
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
      let rootReads = 0
      const ready: Array<number> = []
      const runLineage = ((id: string) =>
        Effect.gen(function*() {
          if (id === "native-root" && ++rootReads === 2) {
            yield* f.sql.withTransaction(Effect.gen(function*() {
              yield* f
                .sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('native-root', 1, -1)`
              yield* f.sql`UPDATE flows_runs SET status = 'pending' WHERE run_id = 'native-root'`
            })).pipe(Effect.orDie)
          }
          return yield* f.runs.lineage(id, { includeState: false })
        })) as typeof f.runs.lineage
      const projector = yield* Projection.make({
        ...f.options,
        runLineage,
        onRootSettled: (generation) =>
          Effect.sync(() => {
            ready.push(generation)
          })
      })
      const follower = yield* Effect.forkScoped(projector.followUntilSettled(f.runs))
      yield* Effect.retry(Effect.suspend(() => rootReads >= 3 ? Effect.void : Effect.fail("waiting")), {
        times: 300,
        schedule: Schedule.spaced("10 millis")
      })
      expect(ready).toEqual([])
      expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([{ reason: "rewound", generation: 1 }])
      yield* Fiber.interrupt(follower)
    }))))

  it("drains a child linked after the terminal membership read and keeps following it", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 0)
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
      let headReads = 0
      const projector = yield* Projection.make({
        ...f.options,
        runLineage: f.runs.lineage,
        engineJournal: {
          ...f.engineJournal,
          heads: (ids) =>
            Effect.gen(function*() {
              if (++headReads === 1) {
                yield* f.runs.create("late-child", stateJson).pipe(Effect.orDie)
                yield* f.engineState.recordRunParent("late-child", "native-root").pipe(Effect.orDie)
                yield* emit(f.engineJournal, "late-child", { value: 1 })
              }
              return yield* f.engineJournal.heads!(ids)
            })
        }
      })
      const follower = yield* Effect.forkScoped(projector.followUntilSettled(f.runs))
      yield* Effect.retry(Effect.suspend(() => headReads >= 3 ? Effect.void : Effect.fail("waiting")), {
        times: 300,
        schedule: Schedule.spaced("10 millis")
      })
      expect(follower.pollUnsafe()).toBeUndefined()
      yield* emit(f.engineJournal, "late-child", { value: 2 }, "fixture", 1)
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'late-child'`
      yield* Fiber.join(follower).pipe(Effect.timeout("5 seconds"))
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).payload)).toEqual([
        { round: 0 },
        { value: 1 },
        { value: 2 }
      ])
    }))))

  it("keeps an empty completed root's readers ready while its detached child remains live", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* f.runs.create("native-root", stateJson)
      yield* f.runs.create("detached", stateJson)
      yield* f.engineState.recordRunParent("detached", "native-root")
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
      const c = counted(f)
      const ready: Array<number> = []
      const projector = yield* Projection.make({
        ...c.options,
        runLineage: f.runs.lineage,
        onRootSettled: (generation) =>
          Effect.sync(() => {
            ready.push(generation)
          })
      })
      const follower = yield* Effect.forkScoped(projector.followUntilSettled(f.runs))
      yield* Effect.retry(Effect.suspend(() => ready.includes(0) ? Effect.void : Effect.fail("waiting")), {
        times: 300,
        schedule: Schedule.spaced("10 millis")
      })
      expect(ready).toContain(0)
      expect(c.reads.entries).toEqual([])
      expect(follower.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(follower)
    }))))

  it("legacy child reads refuse an edge belonging to another member of the same level", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 1)
      const projector = yield* Projection.make({
        ...f.options,
        runLineage: f.runs.lineage,
        engineState: {
          runChildren: (id) =>
            id === "native-root"
              ? Effect.succeed([{ parentId: "round-1", childId: "intruder", seq: 1 }]) :
              f.engineState.runChildren(id)
        }
      })
      expect(yield* Effect.result(projector.catchUp)).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "decode_failed",
          message: "Engine projection received a foreign parent edge"
        }
      })
    }))))

  it("preserves copied traversal order across sibling child lineages and their children", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 0)
      for (const id of ["a", "b"]) {
        yield* f.runs.create(id, stateJson)
        yield* f.engineState.recordRunParent(id, "native-root")
        yield* f.runs.create(`${id}-round`, stateJson, { lineageId: id, roundOrdinal: 1, parentRunId: id })
        yield* f.runs.create(`${id}-child`, stateJson)
        yield* f.engineState.recordRunParent(`${id}-child`, id)
        for (const run of [id, `${id}-round`, `${id}-child`]) yield* emit(f.engineJournal, run, { run })
      }
      yield* (yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })).catchUp
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).executionId)).toEqual([
        "native-root",
        "a",
        "b",
        "a-round",
        "a-child",
        "b-round",
        "b-child"
      ])
    }))))

  it("bulk heads keep idle journal and child reads flat at 8 and 40 rounds", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      for (const count of [8, 40]) {
        const f = yield* setup
        yield* roundsFixture(f, count)
        const c = counted(f)
        let lineageReads = 0
        const runLineage = ((id: string, options?: { readonly includeState: false }) =>
          Effect.suspend(() => {
            lineageReads++
            return f.runs.lineage(id, options ?? { includeState: false })
          })) as typeof f.runs.lineage
        const projector = yield* Projection.make({ ...c.options, runLineage })
        yield* projector.catchUp
        yield* projector.catchUp
        c.reset()
        lineageReads = 0
        yield* emit(f.engineJournal, "round-7", { late: true }, "fixture", 1)
        expect((yield* projector.catchUp).size).toBe(count + 1)
        expect(c.reads).toEqual({ entries: ["round-7"], generations: ["round-7", "round-7"], heads: 1, children: 1 })
        expect(lineageReads).toBe(1)
        expect(yield* rows(f.controlJournal)).toHaveLength(count + 2)
      }
    }))))

  it("bulk heads follow a detached child admitted after its parent completed, including its later records", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 0)
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
      const c = counted(f)
      const projector = yield* Projection.make({ ...c.options, runLineage: f.runs.lineage })
      yield* projector.catchUp
      yield* f.runs.create("detached", stateJson)
      yield* f.engineState.recordRunParent("detached", "native-root")
      yield* emit(f.engineJournal, "detached", { value: 1 })
      yield* projector.catchUp
      c.reset()
      yield* emit(f.engineJournal, "detached", { value: 2 }, "fixture", 1)
      yield* projector.catchUp
      expect(c.reads.entries).toEqual(["detached"])
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).payload)).toEqual([
        { round: 0 },
        { value: 1 },
        { value: 2 }
      ])
    }))))

  it("bulk heads copy a completed child's record when a second in-tree parent joins it", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 1)
      yield* f.runs.create("shared", stateJson)
      yield* f.engineState.recordRunParent("shared", "native-root")
      yield* emit(f.engineJournal, "shared", { value: 1 })
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'shared'`
      const c = counted(f)
      const projector = yield* Projection.make({ ...c.options, runLineage: f.runs.lineage })
      yield* projector.catchUp
      yield* f.engineState.recordRunParent("shared", "round-1")
      yield* emit(f.engineJournal, "shared", { secondParent: true }, "fixture", 1)
      c.reset()
      expect([...(yield* projector.catchUp)]).toEqual(["native-root", "round-1", "shared"])
      expect(c.reads.entries).toEqual(["shared"])
      expect((yield* rows(f.controlJournal)).map(record).filter((row) => row.executionId === "shared")).toMatchObject([
        { payload: { value: 1 } },
        { payload: { secondParent: true } }
      ])
    }))))

  it("bulk heads notice a rewind whose new maximum is below the copied position", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      for (let seq = 0; seq <= 5; seq++) yield* emit(f.engineJournal, "native-root", { seq }, "fixture", seq)
      const c = counted(f)
      const projector = yield* Projection.make(c.options)
      yield* projector.catchUp
      // The same atomic truncation/generation boundary used by time travel.
      yield* f.sql.withTransaction(Effect.gen(function*() {
        yield* f.sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('native-root', 2, 1)`
        yield* f.sql`DELETE FROM flows_journal_events WHERE run_id = 'native-root' AND seq > 1`
      }))
      // A fresh journal writer allocates against the rewound durable tail.
      const writer = Context.get(
        yield* Layer.build(
          SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(
            Layer.provide(Layer.succeedContext(f.native))
          )
        ),
        Journal.Journal
      )
      yield* emit(writer, "native-root", { replayed: true }, "after-rewind", 0)
      yield* emit(writer, "native-root", { replayed: true }, "after-rewind", 1)
      yield* projector.catchUp
      const projected = (yield* rows(f.controlJournal)).map(record)
      expect(projected.filter((row) => row.reason === "rewound")).toMatchObject([{ generation: 2, afterSequence: 1 }])
      expect(projected.filter((row) => row.generation === 2 && row.sequence !== undefined)).toMatchObject([
        { sequence: 0 },
        { sequence: 1 },
        { sequence: 2, payload: { replayed: true } },
        { sequence: 3, payload: { replayed: true } }
      ])
      c.reset()
      yield* projector.catchUp
      expect(c.reads.entries).toEqual([])
    }))))

  it("bulk heads remember an empty rewound generation after one gap and one page", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { before: true })
      const c = counted(f)
      const projector = yield* Projection.make(c.options)
      yield* projector.catchUp
      yield* f.sql.withTransaction(Effect.gen(function*() {
        yield* f
          .sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('native-root', 2, -1)`
        yield* f.sql`DELETE FROM flows_journal_events WHERE run_id = 'native-root'`
      }))
      c.reset()
      yield* projector.catchUp
      expect(c.reads.entries).toEqual(["native-root"])
      c.reset()
      yield* projector.catchUp
      yield* projector.catchUp
      expect(c.reads.entries).toEqual([])
      expect((yield* rows(f.controlJournal)).map(record).filter((row) => row.reason === "rewound")).toEqual([
        { executionId: "native-root", generation: 2, reason: "rewound", afterSequence: -1 }
      ])
    }))))

  it("bulk heads restart by rereading each populated run once without duplicating output", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 8)
      yield* (yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })).catchUp
      const before = yield* rows(f.controlJournal)
      const c = counted(f)
      const restarted = yield* Projection.make({ ...c.options, runLineage: f.runs.lineage })
      yield* restarted.catchUp
      expect(c.reads.entries).toEqual(["native-root", ...Array.from({ length: 8 }, (_, i) => `round-${i + 1}`)])
      c.reset()
      yield* restarted.catchUp
      expect(c.reads.entries).toEqual([])
      expect(yield* rows(f.controlJournal)).toEqual(before)
    }))))

  it("legacy adapters read every member each pass and preserve copied output", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 2)
      const c = counted(f)
      const options = {
        ...c.options,
        engineJournal: { ...c.options.engineJournal, heads: undefined, generation: undefined },
        engineState: { runChildren: f.engineState.runChildren },
        runLineage: f.runs.lineage
      }
      const projector = yield* Projection.make(options)
      yield* projector.catchUp
      const before = yield* rows(f.controlJournal)
      c.reset()
      yield* projector.catchUp
      expect(c.reads.entries).toEqual(["native-root", "round-1", "round-2"])
      expect(yield* rows(f.controlJournal)).toEqual(before)
      yield* (yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })).catchUp
      expect(yield* rows(f.controlJournal)).toEqual(before)
    }))))

  it("bulk child membership refuses a foreign parent edge", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const engineState = {
        ...f.engineState,
        runChildrenOf: () => Effect.succeed([{ childId: "outsider", parentId: "foreign", seq: 1 }])
      }
      const failure = yield* Effect.result((yield* Projection.make({ ...f.options, engineState })).catchUp)
      expect(failure).toMatchObject({
        _tag: "Failure",
        failure: { code: "decode_failed", message: "Engine projection received a foreign parent edge" }
      })
    }))))

  it("bulk heads fall back for an omitted head and refresh membership after edge removal", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { root: true })
      yield* f.engineState.recordRunParent("child", "native-root")
      yield* emit(f.engineJournal, "child", { child: true })
      const c = counted(f)
      const projector = yield* Projection.make({
        ...c.options,
        engineJournal: { ...c.options.engineJournal, heads: () => Effect.succeed([]) }
      })
      yield* projector.catchUp
      c.reset()
      yield* f.engineState.removeRunParentsForRun("child")
      expect([...(yield* projector.catchUp)]).toEqual(["native-root"])
      expect(c.reads.entries).toEqual(["native-root"])
      expect(yield* rows(f.controlJournal)).toHaveLength(2)
    }))))

  it("bulk heads keep following 200 idle rounds with only the changed round paged", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* roundsFixture(f, 200)
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id <> 'round-200'`
      const c = counted(f)
      const projector = yield* Projection.make({ ...c.options, runLineage: f.runs.lineage })
      yield* projector.catchUp
      c.reset()
      const follower = yield* Effect.forkScoped(projector.followUntilSettled(f.runs))
      yield* Effect.retry(Effect.suspend(() => c.reads.heads >= 2 ? Effect.void : Effect.fail("waiting")), {
        times: 300,
        schedule: Schedule.spaced("10 millis")
      })
      expect(c.reads.entries).toEqual([])
      expect(follower.pollUnsafe()).toBeUndefined()
      yield* emit(f.engineJournal, "round-200", { settled: true }, "fixture", 1)
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'round-200'`
      yield* Fiber.join(follower).pipe(Effect.timeout("10 seconds"))
      expect(c.reads.entries).toEqual(["round-200"])
      expect(yield* rows(f.controlJournal)).toHaveLength(202)
    }))))

  it("reopens both SQLite files and converges a committed call outbox after a lost destination receipt", () =>
    Effect.runPromise(Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "call-outbox-"))),
      (directory) =>
        Effect.gen(function*() {
          const open = Effect.gen(function*() {
            const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(join(directory, "native.db"))))
            const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(join(directory, "control.db"))))
            return {
              engineJournal: Context.get(native, Journal.Journal),
              controlJournal: Context.get(control, Journal.Journal),
              engineState: Context.get(native, DurableEngineState.DurableEngineState),
              controlRunId: "control-root",
              executionId: "native-root"
            }
          }).pipe(Effect.provide(NodeCrypto.layer))
          const callId = `cell-call-v1:${"a".repeat(64)}`
          yield* Effect.scoped(Effect.gen(function*() {
            const ports = yield* open
            for (const phase of ["invoked", "settled"] as const) {
              yield* ports.engineJournal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: "native-root" as JournalEvent.RunId,
                  sourceId: `call-fact-v1:${callId}:${phase}` as JournalEvent.SourceId,
                  sourceSeq: 0 as JournalEvent.SourceSeq,
                  eventType: CallFact.eventType,
                  payload: {
                    version: 1,
                    phase,
                    callId,
                    identity: {
                      runId: "control-root",
                      frame: 1,
                      cell: "cell",
                      ordinal: 0,
                      declaration: "d",
                      layers: []
                    },
                    flowName: "write",
                    ...(phase === "invoked"
                      ? { input: { token: "private-input", path: "a" } }
                      : { outcome: "failure", value: null, message: "timeout" })
                  }
                })
              )
            }
            let lost = false
            const controlJournal: Journal.Service = {
              ...ports.controlJournal,
              emitDurableUnfenced: (input) =>
                ports.controlJournal.emitDurableUnfenced(input).pipe(Effect.flatMap((receipt) => {
                  if (input.eventType !== Projection.eventKind || lost) return Effect.succeed(receipt)
                  lost = true
                  return Effect.fail(
                    new Journal.JournalError({ code: "sink_failed", message: "lost receipt after commit" })
                  )
                }))
            }
            expect((yield* Effect.result((yield* Projection.make({ ...ports, controlJournal })).catchUp))._tag).toBe(
              "Failure"
            )
            expect(yield* rows(ports.controlJournal)).toHaveLength(1)
          }))
          yield* Effect.scoped(Effect.gen(function*() {
            const ports = yield* open
            yield* (yield* Projection.make(ports)).catchUp
            const committed = yield* rows(ports.controlJournal)
            expect(committed).toHaveLength(2)
            yield* (yield* Projection.make(ports)).catchUp
            expect(yield* rows(ports.controlJournal)).toEqual(committed)
            expect(JSON.stringify(committed)).not.toContain("private-input")
            const events = committed.map((entry) =>
              Schema.decodeUnknownSync(ControlSchema.ControlEvent)({
                runId: "control-root",
                sequence: entry.seq as number,
                kind: entry.eventType,
                occurredAt: entry.emittedAtMs as number,
                payload: entry.payload
              })
            )
            expect(GatewayProjection.nodeOutput(events)).toMatchObject([{
              nodeId: "call-1",
              outcome: "failure",
              output: "timeout"
            }])
            expect(GatewayProjection.transcript(events)).toHaveLength(2)
          }))
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    )))

  it("commits one trusted binding and follows trampoline membership without rewriting copied identities", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const state = JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
      yield* f.runs.create("native-root", state)
      yield* f.runs.create("round-1", state, { lineageId: "native-root", roundOrdinal: 1, parentRunId: "native-root" })
      yield* emit(f.engineJournal, "native-root", { root: true })
      yield* emit(f.engineJournal, "round-1", { round: true })
      expect(yield* f.engineState.runChildren("native-root")).toEqual([])
      const projector = yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })
      yield* projector.catchUp
      const first = yield* f.controlJournal.entries({ runId: "control-root" as JournalEvent.RunId, limit: 100 })
      expect(first.entries.filter((entry) => entry.eventType === "control.engine.bound").map(record)).toEqual([
        { version: 1, controlRunId: "control-root", executionId: "native-root" }
      ])
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).executionId)).toEqual([
        "native-root",
        "round-1"
      ])
      yield* (yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })).catchUp
      expect((yield* f.controlJournal.entries({ runId: "control-root" as JournalEvent.RunId, limit: 100 })).entries)
        .toEqual(first.entries)
    }))))

  it("reads a lineage once per catch-up, without the rounds' saved state, however many rounds it has", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const state = JSON.stringify({ version: 1, flowName: "agent/run", payload: { large: "x".repeat(4_000) } })
      yield* f.runs.create("native-root", state)
      yield* emit(f.engineJournal, "native-root", { round: 0 })
      const reads: Array<{ readonly runId: string; readonly options: unknown; readonly withState: boolean }> = []
      const runLineage = ((runId: string, options?: { readonly includeState: false }) =>
        Effect.tap(
          options === undefined ? f.runs.lineage(runId) : f.runs.lineage(runId, options),
          (rows) =>
            Effect.sync(() => void reads.push({ runId, options, withState: rows.some((row) => "stateJson" in row) }))
        )) as typeof f.runs.lineage
      const projector = yield* Projection.make({ ...f.options, runLineage })
      for (const rounds of [1, 8, 40]) {
        for (let round = 1; round <= rounds; round++) {
          const runId = `round-${round}`
          const exists = yield* Effect.result(f.runs.get(runId))
          if (exists._tag === "Success") continue
          yield* f.runs.create(runId, state, {
            lineageId: "native-root",
            roundOrdinal: round,
            parentRunId: "native-root"
          })
          yield* emit(f.engineJournal, runId, { round })
        }
        reads.length = 0
        yield* projector.catchUp
        // One read for the whole lineage, asked of the root, whatever its length.
        expect(reads).toEqual([{ runId: "native-root", options: { includeState: false }, withState: false }])
        expect((yield* rows(f.controlJournal)).map((entry) => record(entry).executionId)).toEqual([
          "native-root",
          ...Array.from({ length: rounds }, (_, index) => `round-${index + 1}`)
        ])
      }
    }))))

  it("settles a run of many rounds without reading any round's row: the lineage read gave their statuses", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const state = JSON.stringify({ version: 1, flowName: "agent/run", payload: { large: "x".repeat(4_000) } })
      yield* f.runs.create("native-root", state)
      yield* emit(f.engineJournal, "native-root", { round: 0 })
      for (let round = 1; round <= 40; round++) {
        yield* f.runs.create(`round-${round}`, state, {
          lineageId: "native-root",
          roundOrdinal: round,
          parentRunId: "native-root"
        })
        yield* emit(f.engineJournal, `round-${round}`, { round })
      }
      // Every round but the last has ended; the follower must keep following.
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id <> 'round-40'`
      const rowReads: Array<string> = []
      const projector = yield* Projection.make({ ...f.options, runLineage: f.runs.lineage })
      const follower = yield* Effect.forkScoped(projector.followUntilSettled({
        get: (id) => Effect.tap(f.runs.get(id), () => Effect.sync(() => void rowReads.push(id)))
      }))
      yield* Effect.sleep("300 millis")
      expect(follower.pollUnsafe()).toBeUndefined()
      yield* emit(f.engineJournal, "round-40", { last: true }, "fixture", 1)
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'round-40'`
      yield* Fiber.join(follower).pipe(Effect.timeout("10 seconds"))
      expect(rowReads).toEqual([])
      expect(yield* rows(f.controlJournal)).toHaveLength(42)
    }))))

  it("keeps reading a round after it ended: it can still gain a child and journal records", () =>
    // The engine admits a child under a parent that has completed, and appends records to a completed run
    // (a second parent joining it, a losing claimant). A pass that skipped ended rounds would miss both.
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const state = JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
      yield* f.runs.create("native-root", state)
      yield* f.runs.create("round-1", state, { lineageId: "native-root", roundOrdinal: 1, parentRunId: "native-root" })
      yield* f.runs.create("round-2", state, { lineageId: "native-root", roundOrdinal: 2, parentRunId: "native-root" })
      yield* emit(f.engineJournal, "round-1", { round: 1 })
      yield* f.sql`UPDATE flows_runs SET status = 'completed', finished_at_ms = 100 WHERE run_id = 'round-1'`
      const c = counted(f)
      const projector = yield* Projection.make({ ...c.options, runLineage: f.runs.lineage })
      yield* projector.catchUp
      yield* projector.catchUp
      c.reset()
      // After two passes saw round 1 ended and drained: a late record, and a late child with a record.
      yield* emit(f.engineJournal, "round-1", { late: "claim-lost" }, "fixture", 1)
      yield* f.runs.create("late-child", state)
      yield* f.engineState.recordRunParent("late-child", "round-1")
      yield* emit(f.engineJournal, "late-child", { child: true })
      expect([...(yield* projector.catchUp)].sort()).toEqual(["late-child", "native-root", "round-1", "round-2"])
      expect(c.reads.entries).toEqual(["round-1", "late-child"])
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).executionId)).toEqual([
        "round-1",
        "round-1",
        "late-child"
      ])
    }))))

  it("still refuses a lineage read that omits the run it was asked for or returns a foreign round", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const state = JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
      yield* f.runs.create("native-root", state)
      yield* f.runs.create("other-root", state)
      yield* emit(f.engineJournal, "native-root", { root: true })
      const answering = (runIds: ReadonlyArray<string>) =>
        ((_: string, options?: { readonly includeState: false }) =>
          Effect.map(
            Effect.forEach(runIds, (runId) => f.runs.lineage(runId, options ?? { includeState: false })),
            (found) => found.flat()
          )) as unknown as typeof f.runs.lineage
      for (
        const [runLineage, message] of [
          [answering([]), "Native lineage omitted its requested member"],
          [answering(["native-root", "other-root"]), "Native lineage returned a foreign member"]
        ] as const
      ) {
        const failure = yield* Effect.flip((yield* Projection.make({ ...f.options, runLineage })).catchUp)
        expect(failure).toMatchObject({ code: "decode_failed", message })
      }
    }))))

  it("calls the record hook before that record is readable in the control journal", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { step: "first" }, "first")
      yield* emit(f.engineJournal, "native-root", { step: "second" }, "second")
      // What the control journal already held each time the hook ran. The
      // order is the whole guarantee: a client that acts on a copied record
      // is acting on something this host has already acted on, so a receipt
      // naming `flows/<id>/flow.ts` is readable only once the rebuild behind
      // it is done.
      const seen: Array<{ readonly sequence: number; readonly copied: ReadonlyArray<unknown> }> = []
      const projector = yield* Projection.make({
        ...f.options,
        onRecord: (entry) =>
          rows(f.controlJournal).pipe(
            Effect.map((entries) =>
              void seen.push({ sequence: entry.seq, copied: entries.map((row) => record(row).payload) })
            ),
            Effect.orDie
          )
      })
      yield* projector.catchUp

      expect(seen).toEqual([
        { sequence: 0, copied: [] },
        { sequence: 1, copied: [{ step: "first" }] }
      ])
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).payload)).toEqual([
        { step: "first" },
        { step: "second" }
      ])
    }))))

  it("does not invent missing evidence from native sequence reservations abandoned on rollback", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { committed: "before" }, "before")
      const rollback = yield* Effect.result(f.engineJournal.transact(Effect.gen(function*() {
        yield* emit(f.engineJournal, "native-root", { uncommitted: true }, "rolled-back")
        return yield* Effect.fail("abandon native attempt")
      })))
      expect(rollback._tag).toBe("Failure")
      yield* emit(f.engineJournal, "native-root", { committed: "after" }, "after")
      const native = yield* f.engineJournal.entries({ runId: "native-root" as JournalEvent.RunId, limit: 10 })
      expect(native.entries.map((entry) => entry.seq)).toEqual([0, 2])
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected.map((entry) => entry.eventType)).toEqual([Projection.eventKind, Projection.eventKind])
      expect(projected.map(record)).toMatchObject([
        { sequence: 0, payload: { committed: "before" } },
        { sequence: 2, payload: { committed: "after" } }
      ])
      const restarted = yield* Projection.make(f.options)
      yield* restarted.catchUp
      expect(yield* rows(f.controlJournal)).toEqual(projected)
    }))))

  it("discards a page crossed by a rewind without acquiring the native write transaction", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { before: true })
      let rewind = true
      const source: Journal.Service = {
        ...f.engineJournal,
        transact: () =>
          Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "read side may not take the writer" })),
        entries: (options) =>
          f.engineJournal.entries(options).pipe(Effect.tap(() => {
            if (!rewind) return Effect.void
            rewind = false
            return f.engineJournal.transact(Effect.gen(function*() {
              yield* f
                .sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('native-root', 1, -1)`
              yield* f.sql`UPDATE flows_journal_events SET payload_json = ${
                JSON.stringify({ after: true })
              } WHERE run_id = 'native-root' AND seq = 0`
            })).pipe(Effect.orDie)
          }))
      }
      const projector = yield* Projection.make({ ...f.options, engineJournal: source })
      yield* projector.catchUp
      expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([
        { reason: "rewound", generation: 1 },
        { generation: 1, payload: { after: true } }
      ])
    }))))

  it(
    "reads the committed native page while an independent writer still holds its transaction",
    () =>
      Effect.runPromise(Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-projection-reader-"))),
        (directory) =>
          Effect.scoped(
            Effect.gen(function*() {
              const path = join(directory, "native.sqlite")
              const source = yield* Layer.build(Layer.fresh(TestStores.layerAt(path)))
              const writer = yield* Layer.build(Layer.fresh(TestStores.layerAt(path)))
              const destination = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
              const engineJournal = Context.get(source, Journal.Journal)
              const controlJournal = Context.get(destination, Journal.Journal)
              yield* emit(engineJournal, "native-root", { committed: true })
              const entered = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const writerJournal = Context.get(writer, Journal.Journal)
              const held = yield* Effect.forkScoped(writerJournal.transact(Effect.gen(function*() {
                yield* emit(writerJournal, "native-root", { uncommitted: true }, "writer")
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              })))
              yield* Deferred.await(entered)
              const projector = yield* Projection.make({
                engineJournal,
                controlJournal,
                engineState: Context.get(source, DurableEngineState.DurableEngineState),
                controlRunId: "control-root",
                executionId: "native-root"
              })
              yield* projector.catchUp.pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
              expect((yield* rows(controlJournal)).map(record)).toMatchObject([{ payload: { committed: true } }])
              yield* Fiber.join(held)
              yield* projector.catchUp
              expect((yield* rows(controlJournal)).map(record)).toMatchObject([
                { payload: { committed: true } },
                { payload: { uncommitted: true } }
              ])
            }).pipe(Effect.provide(NodeCrypto.layer))
          ),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
      )),
    30_000
  )

  it("records an exact omission for a destination size refusal and continues into later events and children", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const bounded = yield* Layer.build(
        SqlJournal.layer({ capacity: 1024, overflow: "reject", maxEntryBytes: 1024 }).pipe(
          Layer.provide(TestStores.databaseAt(":memory:")),
          Layer.provide(NodeCrypto.layer)
        )
      )
      const controlJournal = Context.get(bounded, Journal.Journal)
      yield* emit(f.engineJournal, "native-root", { large: "x".repeat(2048) }, "large")
      yield* emit(f.engineJournal, "native-root", { next: true }, "small")
      yield* f.engineState.recordRunParent("child", "native-root")
      yield* emit(f.engineJournal, "child", { child: true })
      const projector = yield* Projection.make({ ...f.options, controlJournal })
      yield* projector.catchUp
      const projected = yield* rows(controlJournal)
      expect(projected.map(record)).toMatchObject([
        { reason: "invalid_event", fromSequence: 0, throughSequence: 0 },
        { sequence: 1, payload: { next: true } },
        { executionId: "child", payload: { child: true } }
      ])
      const restarted = yield* Projection.make({ ...f.options, controlJournal })
      yield* restarted.catchUp
      expect(yield* rows(controlJournal)).toEqual(projected)
    }))))

  it("copies native outcomes and recorded child edges, ignores prefix lookalikes, and deduplicates a restart", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", {
        result: { _tag: "Success", value: { check: "typecheck", passed: true } }
      }, "first")
      yield* emit(f.engineJournal, "native-root", { state: "failed" }, "second")
      yield* f.engineState.recordRunParent("unrelated-opaque-id", "native-root")
      yield* emit(f.engineJournal, "unrelated-opaque-id", { child: "recorded" })
      yield* emit(f.engineJournal, "native-root-prefix-lookalike", { secret: "not owned" })
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      const first = yield* rows(f.controlJournal)
      expect(first).toHaveLength(3)
      expect(first.every((entry) => entry.eventType === Projection.eventKind)).toBe(true)
      expect(first.map((entry) => record(entry).executionId)).toEqual([
        "native-root",
        "native-root",
        "unrelated-opaque-id"
      ])
      expect(record(first[0]!)).toMatchObject({
        version: 1,
        sequence: 0,
        sourceSequence: 0,
        sourceId: "first",
        eventType: "flows.engine.attempt-finished",
        meta: { lineageId: "native-lineage" },
        payload: { result: { _tag: "Success", value: { check: "typecheck", passed: true } } }
      })
      expect(record(first[1]!)).toMatchObject({ sequence: 1, sourceSequence: 0, sourceId: "second" })
      expect(first[0]?.sourceId).not.toBe(first[2]?.sourceId)
      const restarted = yield* Projection.make(f.options)
      yield* restarted.catchUp
      expect(yield* rows(f.controlJournal)).toEqual(first)
    }))))

  it("retries an acknowledged destination write after a lost response without skipping the page", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { first: true }, "one")
      yield* emit(f.engineJournal, "native-root", { second: true }, "two")
      let lose = true
      const destination: Journal.Service = {
        ...f.controlJournal,
        emitDurableUnfenced: (input) =>
          Effect.flatMap(f.controlJournal.emitDurableUnfenced(input), (receipt) => {
            if (!lose) return Effect.succeed(receipt)
            lose = false
            return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "lost response after commit" }))
          })
      }
      const projector = yield* Projection.make({ ...f.options, controlJournal: destination })
      expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
      yield* projector.catchUp
      expect((yield* rows(f.controlJournal)).map((entry) => record(entry).payload)).toEqual([{ first: true }, {
        second: true
      }])
    }))))

  it("preserves changed native sequence values under a new rewind generation", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { before: true })
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      yield* f.sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('native-root', 1, -1)
        ON CONFLICT (run_id) DO UPDATE SET generation = 1, after_seq = -1`
      yield* f.sql`UPDATE flows_journal_events SET payload_json = ${
        JSON.stringify({ after: true })
      } WHERE run_id = 'native-root' AND seq = 0`
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected).toHaveLength(3)
      expect(record(projected[0]!)).toMatchObject({ generation: 0, sequence: 0, payload: { before: true } })
      expect(projected[1]?.eventType).toBe(Projection.gapKind)
      expect(record(projected[1]!)).toMatchObject({ reason: "rewound", generation: 1, afterSequence: -1 })
      expect(record(projected[2]!)).toMatchObject({ generation: 1, sequence: 0, payload: { after: true } })
      const restarted = yield* Projection.make(f.options)
      yield* restarted.catchUp
      expect(yield* rows(f.controlJournal)).toEqual(projected)
    }))))

  it("reports compacted and missing sequences without inventing native completion", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const owner = { hostId: "host", pid: 42, nonce: "nonce" }
      yield* f.runs.create("native-root", JSON.stringify({ version: 1, flowName: "fixture", payload: {} }))
      yield* f
        .sql`UPDATE flows_runs SET status = 'running', owner_host_id = ${owner.hostId}, owner_pid = ${owner.pid}, owner_nonce = ${owner.nonce}, heartbeat_at_ms = 1 WHERE run_id = 'native-root'`
      yield* f
        .sql`INSERT INTO flows_consensus_leases (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms) VALUES ('native-root', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, 1)`
      yield* emit(f.engineJournal, "native-root", { value: 0 }, "zero")
      yield* emit(f.engineJournal, "native-root", { value: 1 }, "one")
      yield* emit(f.engineJournal, "native-root", { value: 2 }, "two")
      yield* emit(f.engineJournal, "native-root", { value: 3 }, "three")
      yield* f.engineJournal.checkpoint({
        runId: "native-root" as JournalEvent.RunId,
        seq: 1 as JournalEvent.Seq,
        state: null
      }, owner)
      expect((yield* f.engineJournal.compact({ runId: "native-root" as JournalEvent.RunId }, owner)).deleted).toBe(1)
      const c = counted(f)
      const projector = yield* Projection.make(c.options)
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected.map((entry) => entry.eventType)).toEqual([
        Projection.gapKind,
        Projection.eventKind,
        Projection.eventKind,
        Projection.eventKind
      ])
      expect(projected.map(record)).toMatchObject([
        { reason: "compacted", throughSequence: 0 },
        { sequence: 1, payload: { value: 1 } },
        { sequence: 2, payload: { value: 2 } },
        { sequence: 3, payload: { value: 3 } }
      ])
      yield* f.engineJournal.checkpoint({
        runId: "native-root" as JournalEvent.RunId,
        seq: 3 as JournalEvent.Seq,
        state: null
      }, owner)
      yield* f.engineJournal.compact({ runId: "native-root" as JournalEvent.RunId }, owner)
      c.reset()
      yield* projector.catchUp
      expect(c.reads.entries).toEqual([])
      expect(yield* rows(f.controlJournal)).toEqual(projected)
    }))))

  it("pages beyond one batch and follows newly recorded children", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* f.engineJournal.transact(
        Effect.forEach(
          Array.from({ length: 260 }, (_, index) => index),
          (index) => emit(f.engineJournal, "native-root", { index }, "batch", index),
          { discard: true }
        )
      )
      const projector = yield* Projection.make(f.options)
      yield* projector.catchUp
      expect(yield* rows(f.controlJournal)).toHaveLength(260)
      const follower = yield* Effect.forkScoped(projector.follow)
      yield* f.engineState.recordRunParent("later-child", "native-root")
      yield* emit(f.engineJournal, "later-child", { observed: true })
      const observed = yield* Effect.retry(
        Effect.gen(function*() {
          const projected = yield* rows(f.controlJournal)
          return projected.length === 261 ? projected : yield* Effect.fail("not copied yet")
        }),
        { times: 200, schedule: Schedule.spaced("10 millis") }
      ).pipe(Effect.timeout("5 seconds"))
      expect(record(observed[260]!)).toMatchObject({ executionId: "later-child", payload: { observed: true } })
      yield* Fiber.interrupt(follower)
    }))))

  it("rechecks durable history written by an independent SQLite connection", () =>
    Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-engine-projection-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
        )
        const filename = join(directory, "engine.db")
        const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(filename)))
        const writer = yield* Layer.build(Layer.fresh(TestStores.layerAt(filename)))
        const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
        const destination = Context.get(control, Journal.Journal)
        const firstRead = yield* Deferred.make<void>()
        const source = Context.get(native, Journal.Journal)
        const projector = yield* Projection.make({
          engineJournal: {
            ...source,
            heads: (ids) => source.heads!(ids).pipe(Effect.tap(() => Deferred.succeed(firstRead, undefined)))
          },
          engineState: Context.get(native, DurableEngineState.DurableEngineState),
          controlJournal: destination,
          controlRunId: "control-root",
          executionId: "native-root"
        })
        const follower = yield* Effect.forkScoped(projector.follow)
        // The first empty head is already read. This separate writer cannot
        // wake the source journal's PubSub, so only the durable recheck finds it.
        yield* Deferred.await(firstRead)
        yield* emit(Context.get(writer, Journal.Journal), "native-root", { externalWriter: true })
        const observed = yield* Effect.retry(
          Effect.gen(function*() {
            const projected = yield* rows(destination)
            return projected.length === 1 ? projected : yield* Effect.fail("not copied yet")
          }),
          { times: 200, schedule: Schedule.spaced("10 millis") }
        ).pipe(Effect.timeout("5 seconds"))
        expect(record(observed[0]!)).toMatchObject({ executionId: "native-root", payload: { externalWriter: true } })
        yield* Fiber.interrupt(follower)
      }).pipe(Effect.provide(NodeCrypto.layer))
    )))

  it("records a read failure and refuses a successful catch-up until the source recovers", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* emit(f.engineJournal, "native-root", { real: true })
      let unavailable = true
      const source: Journal.Service = {
        ...f.engineJournal,
        entries: (options) =>
          unavailable
            ? Effect.fail(new Journal.JournalError({ code: "read_failed", message: "unavailable" }))
            : f.engineJournal.entries(options)
      }
      const projector = yield* Projection.make({ ...f.options, engineJournal: source })
      expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
      expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
      expect(yield* rows(f.controlJournal)).toHaveLength(1)
      unavailable = false
      yield* projector.catchUp
      const projected = yield* rows(f.controlJournal)
      expect(projected.map((entry) => entry.eventType)).toEqual([Projection.gapKind, Projection.eventKind])
      expect(record(projected[0]!)).toMatchObject({ reason: "read_failed", afterSequence: -1 })
      expect(record(projected[1]!)).toMatchObject({ payload: { real: true } })
    }))))

  it.each([1, 2] as const)(
    "records a refusal of generation read %i without guessing the current generation",
    (phase) =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const refusal = Effect.fail(new Journal.JournalError({ code: "read_failed", message: "storage unavailable" }))
        let reads = 0
        const source: Journal.Service = {
          ...f.engineJournal,
          heads: undefined,
          generation: (id) => ++reads === phase ? refusal : f.engineJournal.generation!(id)
        }
        const projector = yield* Projection.make({ ...f.options, engineJournal: source })
        expect((yield* Effect.result(projector.catchUp))._tag).toBe("Failure")
        expect((yield* rows(f.controlJournal)).map(record)).toEqual([{
          executionId: "native-root",
          generation: null,
          reason: "read_failed",
          phase: "source-generation",
          lastObservedGeneration: null,
          afterSequence: -1
        }])
      })))
  )

  it("waits for an admitted native run to exist and reach a terminal commit", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      const observedAdmission = yield* Deferred.make<void>()
      const runs: Pick<RunStore.Service, "get"> = {
        get: (id) =>
          f.runs.get(id).pipe(
            Effect.onExit(() => Deferred.succeed(observedAdmission, undefined))
          )
      }
      const projector = yield* Projection.make(f.options)
      let finished = false
      const follower = yield* Effect.forkScoped(
        projector.followUntilSettled(runs).pipe(Effect.tap(() => {
          finished = true
          return Effect.void
        }))
      )
      yield* Deferred.await(observedAdmission)
      expect(finished).toBe(false)
      yield* f.engineJournal.transact(Effect.gen(function*() {
        yield* f.runs.create("native-root", JSON.stringify({ version: 1, flowName: "fixture", payload: {} }))
        yield* emit(f.engineJournal, "native-root", {
          result: { _tag: "Success", value: "committed after handler return" }
        })
        yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
      }))
      yield* Fiber.join(follower).pipe(Effect.timeout("5 seconds"))
      expect(finished).toBe(true)
      expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([
        { payload: { result: { _tag: "Success", value: "committed after handler return" } } }
      ])
    }))))

  it("drains a terminal event committed after the preceding page but before the terminal row read", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const f = yield* setup
      yield* f.runs.create("native-root", JSON.stringify({ version: 1, flowName: "fixture", payload: {} }))
      let pageReads = 0
      let rowReads = 0
      const projector = yield* Projection.make({
        ...f.options,
        engineJournal: {
          ...f.engineJournal,
          heads: undefined,
          entries: (options) =>
            f.engineJournal.entries(options).pipe(Effect.tap(() => {
              pageReads++
              return Effect.void
            }))
        }
      })
      yield* projector.followUntilSettled({
        get: (id) =>
          Effect.gen(function*() {
            rowReads++
            // The first catchUp has already fetched the empty source page. Commit
            // the native result now, then return the actual terminal SQL row.
            expect(pageReads).toBe(1)
            yield* f.engineJournal.transact(Effect.gen(function*() {
              yield* emit(f.engineJournal, "native-root", { result: { _tag: "Success", value: "final drain" } })
              yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
            })).pipe(Effect.orDie)
            return yield* f.runs.get(id)
          })
      }).pipe(Effect.timeout("5 seconds"))
      expect(rowReads).toBe(1)
      expect(pageReads).toBe(2)
      expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([
        { payload: { result: { _tag: "Success", value: "final drain" } } }
      ])
    }))))
})

it("keeps projecting detached descendants after the native root completes", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const f = yield* setup
    const state = JSON.stringify({ version: 1, flowName: "fixture", payload: {} })
    yield* f.runs.create("native-root", state)
    yield* f.runs.create("detached", state)
    yield* f.engineState.recordRunParent("detached", "native-root")
    yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'native-root'`
    yield* f.sql`UPDATE flows_runs SET status = 'suspended' WHERE run_id = 'detached'`
    const childRead = yield* Deferred.make<void>()
    const projector = yield* Projection.make(f.options)
    const follower = yield* Effect.forkScoped(projector.followUntilSettled({
      get: (id) =>
        f.runs.get(id).pipe(Effect.tap(() => id === "detached" ? Deferred.succeed(childRead, undefined) : Effect.void))
    }))
    const first = yield* Effect.raceFirst(
      Fiber.join(follower).pipe(Effect.as("settled")),
      Deferred.await(childRead).pipe(Effect.as("child-observed"))
    )
    expect(first).toBe("child-observed")
    yield* f.engineJournal.transact(Effect.gen(function*() {
      yield* emit(f.engineJournal, "detached", { late: "descendant output" })
      yield* f.sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'detached'`
    }))
    yield* Fiber.join(follower).pipe(Effect.timeout("5 seconds"))
    expect((yield* rows(f.controlJournal)).map(record)).toMatchObject([
      { executionId: "detached", payload: { late: "descendant output" } }
    ])
  }))))
