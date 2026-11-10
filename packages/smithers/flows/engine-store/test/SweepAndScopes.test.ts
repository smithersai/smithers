import { describe, expect, it } from "@effect/vitest"
import { DurableClock, Flow } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { type Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.vibe"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "sweep-test", pid: 3, nonce: "sweep" }

const FlowA = Flow.make("Sweep/FlowA", { payload: {}, success: Schema.String, body: () => Node.succeed("unused") })
const FlowB = Flow.make("Sweep/FlowB", { payload: {}, success: Schema.String, body: () => Node.succeed("unused") })

const makeJournal = (events: Array<string>, options: { readonly flushFails?: boolean } = {}) => {
  let seq = 0
  const record = (input: JournalEvent.Input) =>
    Effect.sync(() => {
      events.push(input.eventType)
      return {
        _tag: "Accepted" as const,
        seq: seq++ as JournalEvent.Seq,
        sourceSeq: 0 as JournalEvent.SourceSeq
      }
    })
  return Journal.makeNoop({
    emitDurable: record,
    emitDurableUnfenced: record,
    flush: options.flushFails
      ? Effect.fail(
        new Journal.JournalError({
          code: "sink_failed",
          message: "sink_failed: lossy writer is latched",
          cause: undefined
        })
      )
      : Effect.void
  })
}

const build = (
  state: DurableEngineState.Service,
  journal: Journal.Service,
  resumes: Array<string>
) =>
  DeferredPersistence.make({
    owner,
    journalSource: "sweep-test",
    scheduleResume: (flowName, executionId, reason) =>
      Effect.sync(() => {
        resumes.push(`${flowName}/${executionId}:${reason}`)
      })
  }).pipe(
    Effect.provideService(DurableEngineState.DurableEngineState, state),
    Effect.provideService(Journal.Journal, journal)
  )

describe("DeferredPersistence.sweepDue", () => {
  it.effect("re-arms every flow's pending clocks when no flow name scopes the sweep", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          const journal = makeJournal(events)

          yield* Effect.scoped(Effect.gen(function*() {
            const first = yield* build(state, journal, resumes)
            yield* first.scheduleClock(FlowA, {
              executionId: "a-run",
              clock: DurableClock.make({ name: "a-wake", duration: "10 seconds" })
            })
            yield* first.scheduleClock(FlowB, {
              executionId: "b-run",
              clock: DurableClock.make({ name: "b-wake", duration: "20 seconds" })
            })
            // A completed deferred exists too; an unscoped sweep has no flow to
            // recover wakes for, so it must not schedule one.
            yield* first.deferredDone({
              flowName: FlowA._tag,
              executionId: "a-run",
              deferredName: "answer",
              exit: Exit.succeed("done")
            })
          }))
          const resumesAfterSetup = resumes.length

          const restarted = yield* build(state, journal, resumes)
          yield* restarted.sweepDue()
          yield* TestClock.adjust("20 seconds")
          yield* Effect.yieldNow
          return {
            resumesFromSweep: resumes.slice(resumesAfterSetup),
            clocks: yield* state.pendingClocks({})
          }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      // Both flows' clocks fired, proving the unscoped sweep armed them all.
      expect(result.clocks).toEqual([])
      expect(result.resumesFromSweep.sort()).toEqual([
        "Sweep/FlowA/a-run:clock",
        "Sweep/FlowB/b-run:clock"
      ])
    }))

  it.effect("continues after a committed durable write when the lossy flush fails", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          const service = yield* build(state, makeJournal(events, { flushFails: true }), resumes)
          yield* service.deferredDone({
            flowName: FlowA._tag,
            executionId: "flush-fails",
            deferredName: "answer",
            exit: Exit.succeed("done")
          })
          return {
            events,
            resumes,
            stored: yield* state.deferred({
              flowName: FlowA._tag,
              executionId: "flush-fails",
              deferredName: "answer"
            })
          }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      // The durable completion is persisted and the wake still scheduled: a
      // latched lossy writer never blocks durable delivery.
      expect(Option.isSome(result.stored)).toBe(true)
      expect(result.events).toContain("flows.engine.deferred-completed")
      expect(result.resumes).toEqual([`${FlowA._tag}/flush-fails:deferred`])
    }))
})

describe("in-memory pendingClocks scoping", () => {
  const clockBase = { deferredName: "deferred", completedAtMs: null }

  it.effect("intersects the execution and flow scopes and excludes non-matching rows", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const result = yield* withCrypto(Effect.gen(function*() {
        yield* state.scheduleClock(
          { ...clockBase, flowName: FlowA._tag, executionId: "run-1", clockName: "a1", dueAtMs: 10 },
          owner
        )
        yield* state.scheduleClock(
          { ...clockBase, flowName: FlowB._tag, executionId: "run-1", clockName: "b1", dueAtMs: 20 },
          owner
        )
        yield* state.scheduleClock(
          { ...clockBase, flowName: FlowA._tag, executionId: "run-2", clockName: "a2", dueAtMs: 30 },
          owner
        )
        return {
          both: yield* state.pendingClocks({ executionId: "run-1", flowName: FlowA._tag }),
          bothMismatched: yield* state.pendingClocks({ executionId: "run-2", flowName: FlowB._tag }),
          byFlow: yield* state.pendingClocks({ flowName: FlowB._tag }),
          byExecution: yield* state.pendingClocks({ executionId: "run-1" }),
          all: yield* state.pendingClocks({})
        }
      }))

      expect(result.both.map((row) => row.clockName)).toEqual(["a1"])
      expect(result.bothMismatched).toEqual([])
      expect(result.byFlow.map((row) => row.clockName)).toEqual(["b1"])
      expect(result.byExecution.map((row) => row.clockName)).toEqual(["a1", "b1"])
      expect(result.all.map((row) => row.clockName)).toEqual(["a1", "b1", "a2"])
    }))

  it.effect("orders scoped results by deadline, then execution id, then clock name", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const listed = yield* withCrypto(Effect.gen(function*() {
        yield* state.scheduleClock(
          { ...clockBase, flowName: FlowA._tag, executionId: "run-2", clockName: "z", dueAtMs: 100 },
          owner
        )
        yield* state.scheduleClock(
          { ...clockBase, flowName: FlowA._tag, executionId: "run-1", clockName: "z", dueAtMs: 100 },
          owner
        )
        yield* state.scheduleClock(
          { ...clockBase, flowName: FlowA._tag, executionId: "run-1", clockName: "a", dueAtMs: 100 },
          owner
        )
        yield* state.scheduleClock(
          { ...clockBase, flowName: FlowA._tag, executionId: "run-9", clockName: "early", dueAtMs: 1 },
          owner
        )
        return yield* state.pendingClocks({ flowName: FlowA._tag })
      }))

      expect(listed.map((row) => [row.dueAtMs, row.executionId, row.clockName])).toEqual([
        [1, "run-9", "early"],
        [100, "run-1", "a"],
        [100, "run-1", "z"],
        [100, "run-2", "z"]
      ])
    }))
})
