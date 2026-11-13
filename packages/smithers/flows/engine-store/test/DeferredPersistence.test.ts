/**
 * `DeferredPersistence` over the production stores: the SQL journal, run
 * store and engine state on one database (SQLite, or PostgreSQL under the
 * storage matrix). Every run a case touches exists in `flows_runs`, owned
 * through `RunStore`, and every record a case asserts is read back from the
 * journal with `entries`. The three fault cases wrap that real journal and
 * fail one of its calls.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as Migrations from "../src/Migrations.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

/** The stored row of a completion for a run the store has. */
const storedRow = (outcome: DurableEngineState.CompleteDeferredOutcome): DurableEngineState.DeferredRow => {
  if (outcome._tag === "NotFound") throw new Error("completion refused: no such run")
  return outcome.row
}

const owner = {
  hostId: "deferred-test",
  pid: 1,
  nonce: "owner"
}

const TestFlow = Flow.make("DeferredPersistence/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 256, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
)

type Services =
  | Journal.Journal
  | RunStore.RunStore
  | DurableEngineState.DurableEngineState
  | SqlClient.SqlClient
  | DurableWriter
  | Scope.Scope

/** The stores over one fresh database, on a virtual clock. */
const run = <A, E>(body: Effect.Effect<A, E, Services>, database = TestStores.database) =>
  withCrypto(
    Effect.scoped(body).pipe(
      Effect.provide(Layer.provideMerge(services, database)),
      Effect.provide(TestClock.layer())
    )
  )

/**
 * Observe actual virtual-clock registration, after SQL rollback has unwound.
 * Starting the delegated sleep immediately registers it before publishing the
 * notice; joining its child preserves the real clock and cancellation.
 */
const observedSleeps = Effect.gen(function*() {
  const base = yield* Clock.Clock
  const registered = new Set<number>()
  const clock: Clock.Clock = {
    ...base,
    sleep: (duration) =>
      Effect.gen(function*() {
        const sleeping = yield* base.sleep(duration).pipe(Effect.forkChild({ startImmediately: true }))
        registered.add(Duration.toMillis(duration))
        yield* Fiber.join(sleeping)
      })
  }
  return {
    clock,
    waitFor: (millis: number) => TestDatabase.until(Effect.sync(() => registered.has(millis)))
  }
})

/** Creates a run and leaves it running under `owner`, so it may park and schedule clocks. */
const owned = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const outcome = yield* runs.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 0)
    expect(outcome).toEqual({ _tag: "Activated" })
  })

/** The event types `journal` committed for one run, in order. */
const entryTypes = (journal: Journal.Service, runId: string) =>
  journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 }).pipe(
    Effect.map((page) => page.entries.map((entry) => entry.eventType)),
    Effect.orDie
  )

/** The event types the journal committed for one run, in order. */
const recorded = (runId: string) => Effect.flatMap(Journal.Journal, (journal) => entryTypes(journal, runId))

const count = (types: ReadonlyArray<string>, eventType: string) => types.filter((type) => type === eventType).length

interface BuildOptions {
  /** Whose ownership the persistence fences its clock schedules on. */
  readonly owner?: typeof owner
  /** Replaces the journal in context, to inject a fault around it. */
  readonly journal?: Journal.Service
  /** Replaces the engine state in context, as a restarted process builds its own. */
  readonly state?: DurableEngineState.Service
  /** Runs inside `scheduleResume`, before the resume is recorded. */
  readonly onResume?: Effect.Effect<void>
  readonly fireRetryPolicy?: DeferredPersistence.FireRetryPolicy
}

const build = (resumes: Array<string>, options: BuildOptions = {}) =>
  Effect.gen(function*() {
    const journal = options.journal ?? (yield* Journal.Journal)
    const state = options.state ?? (yield* DurableEngineState.DurableEngineState)
    return yield* DeferredPersistence.make({
      owner: options.owner ?? owner,
      journalSource: "deferred-test",
      scheduleResume: (_flowName, executionId, reason) =>
        Effect.andThen(
          options.onResume ?? Effect.void,
          Effect.sync(() => {
            resumes.push(`${executionId}:${reason}`)
          })
        ),
      fireRetryPolicy: options.fireRetryPolicy
    }).pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, state),
      Effect.provideService(Journal.Journal, journal)
    )
  })

describe("DeferredPersistence", () => {
  it.effect("two armed timer services complete the clock once and keep both deliveries idempotent", () =>
    run(Effect.gen(function*() {
      yield* owned("competing-timers")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const first = yield* build(resumes)
      const second = yield* build(resumes, { state: yield* DurableEngineState.make })
      const clock = DurableClock.make({ name: "competing", duration: "1 second" })
      yield* first.scheduleClock(TestFlow, { executionId: "competing-timers", clock })
      yield* second.scheduleClock(TestFlow, { executionId: "competing-timers", clock })
      yield* TestClock.adjust("1 second")
      yield* TestDatabase.until(Effect.sync(() => resumes.length === 2))
      const address = { flowName: TestFlow._tag, executionId: "competing-timers", clockName: clock.name }
      expect(Option.getOrThrow(yield* state.clock(address)).completedAtMs).toBe(1_000)
      expect(
        Option.getOrThrow(
          yield* state.deferred({
            ...address,
            deferredName: clock.deferred.name
          })
        ).exit
      ).toEqual(Exit.void)
      expect(resumes).toEqual(["competing-timers:clock", "competing-timers:clock"])
      const types = yield* recorded("competing-timers")
      expect(count(types, "flows.engine.clock-scheduled")).toBe(1)
      expect(count(types, "flows.engine.clock-completed")).toBe(1)
      expect(count(types, "flows.engine.deferred-completed")).toBe(1)
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
      expect(resumes).toHaveLength(2)
    })))

  it.effect("rehydrates valid exits and leaves malformed lookalikes inert", () =>
    // The memory engine state's own decoding: no journal and no persistence.
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const malformed: ReadonlyArray<unknown> = [
        1,
        { _id: "Other" },
        { _id: "Exit", _tag: "Other" },
        { _id: "Exit", _tag: "Failure", cause: null },
        { _id: "Exit", _tag: "Failure", cause: {} },
        { _id: "Exit", _tag: "Failure", cause: { reasons: "invalid" } },
        { _id: "Exit", _tag: "Failure", cause: { reasons: [null] } },
        { _id: "Exit", _tag: "Failure", cause: { reasons: [{ _tag: "Unknown" }] } },
        { _id: "Exit", _tag: "Failure", cause: { failures: [null] } },
        { _id: "Exit", _tag: "Failure", cause: { failures: [{ _tag: "Unknown" }] } }
      ]
      for (const [index, exit] of malformed.entries()) {
        const completed = yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: `malformed-${index}`,
          deferredName: "answer",
          exit,
          completedAtMs: 0
        })
        expect(storedRow(completed).exit).toEqual(exit)
      }

      for (const field of ["failures", "reasons"]) {
        const completed = yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: `${field}-failure`,
          deferredName: "answer",
          exit: { _id: "Exit", _tag: "Failure", cause: { [field]: [{ _tag: "Fail", error: "stored" }] } },
          completedAtMs: 0
        })
        expect(storedRow(completed).exit).toEqual(Exit.fail("stored"))
      }

      const interrupted = yield* state.completeDeferred({
        flowName: TestFlow._tag,
        executionId: "numeric-interrupt",
        deferredName: "answer",
        exit: {
          _id: "Exit",
          _tag: "Failure",
          cause: { failures: [{ _tag: "Interrupt", fiberId: 7 }] }
        },
        completedAtMs: 0
      })
      expect(Exit.isFailure(storedRow(interrupted).exit as Exit.Exit<unknown, unknown>)).toBe(true)
      expect((storedRow(interrupted).exit as Exit.Failure<unknown, unknown>).cause.reasons[0]).toMatchObject({
        _tag: "Interrupt",
        fiberId: 7
      })
    }))

  it.effect("restores both current and legacy failure arrays without losing a reason", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const original = Exit.failCause(Cause.fromReasons([
        Cause.makeFailReason("typed refusal"),
        Cause.makeDieReason("defect"),
        Cause.makeInterruptReason(7),
        Cause.makeInterruptReason()
      ]))
      const encoded = JSON.parse(JSON.stringify(original))
      for (const field of ["reasons", "failures"] as const) {
        const wire = { ...encoded, cause: { _id: "Cause", [field]: encoded.cause.reasons } }
        const completed = yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: `cause-${field}`,
          deferredName: "answer",
          exit: wire,
          completedAtMs: 0
        })
        expect(storedRow(completed).exit).toEqual(original)
        expect(
          Option.getOrThrow(
            yield* state.deferred({
              flowName: TestFlow._tag,
              executionId: `cause-${field}`,
              deferredName: "answer"
            })
          ).exit
        ).toEqual(original)
      }
    }))

  it.effect("keeps the first duplicate or divergent completion", () =>
    run(Effect.gen(function*() {
      yield* owned("duplicate")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const service = yield* build(resumes)
      const address = {
        flowName: TestFlow._tag,
        executionId: "duplicate",
        deferredName: "answer"
      }

      yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
      yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
      yield* service.deferredDone({ ...address, exit: Exit.succeed("different") })

      expect(Option.getOrThrow(yield* state.deferred(address)).exit).toEqual(Exit.succeed("first"))
      expect(yield* recorded("duplicate")).toEqual(["flows.engine.deferred-completed"])
      expect(resumes).toEqual([
        "duplicate:deferred",
        "duplicate:deferred",
        "duplicate:deferred"
      ])
    })))

  it.effect("admits only the exact active wait and converges concurrent duplicates", () =>
    run(Effect.gen(function*() {
      yield* owned("approval-cas")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const service = yield* build(resumes)
      const address = {
        flowName: TestFlow._tag,
        executionId: "approval-cas",
        deferredName: "answer"
      }
      const completion = {
        ...address,
        reason: "approval",
        token: "attempt-1",
        exit: Exit.succeed("yes")
      }

      const unopened = yield* service.deferredDoneIfWaiting(completion)
      expect(
        yield* state.park(address.executionId, {
          reason: "approval",
          token: completion.token
        }, owner)
      ).toMatchObject({ _tag: "Parked" })
      const duplicates = yield* Effect.all([
        service.deferredDoneIfWaiting(completion),
        service.deferredDoneIfWaiting({ ...completion, exit: Exit.succeed("different") })
      ], { concurrency: "unbounded" })

      yield* state.park(address.executionId, {
        reason: "approval",
        token: "attempt-2"
      }, owner)
      const stale = yield* service.deferredDoneIfWaiting({
        ...completion,
        deferredName: "answer-2"
      })
      const current = yield* service.deferredDoneIfWaiting({
        ...completion,
        deferredName: "answer-2",
        token: "attempt-2"
      })

      expect(unopened).toBe("NotWaiting")
      expect([...duplicates].sort()).toEqual(["Completed", "Existing"])
      expect(stale).toBe("NotWaiting")
      expect(current).toBe("Completed")
      expect([Exit.succeed("yes"), Exit.succeed("different")]).toContainEqual(
        Option.getOrThrow(yield* state.deferred(address)).exit
      )
      expect(Option.getOrThrow(yield* state.deferred({ ...address, deferredName: "answer-2" })).exit).toEqual(
        Exit.succeed("yes")
      )
      expect(count(yield* recorded("approval-cas"), "flows.engine.deferred-completed")).toBe(2)
      expect(resumes).toHaveLength(3)
    })))

  it.effect("makes delivery durable before scheduling a resume", () =>
    run(Effect.gen(function*() {
      yield* owned("ordered")
      const journal = yield* Journal.Journal
      // A second engine state over the same database: what it reads is what
      // committed, not what this process holds.
      const observer = yield* DurableEngineState.make
      const resumes: Array<string> = []
      const address = {
        flowName: TestFlow._tag,
        executionId: "ordered",
        deferredName: "answer"
      }
      const atResume: Array<{
        readonly types: ReadonlyArray<string>
        readonly row: Option.Option<DurableEngineState.DeferredRow>
      }> = []

      const service = yield* build(resumes, {
        onResume: Effect.gen(function*() {
          atResume.push({ types: yield* entryTypes(journal, "ordered"), row: yield* observer.deferred(address) })
        })
      })
      yield* service.deferredDone({
        ...address,
        exit: Exit.succeed("done"),
        metadata: { correlationId: "opaque" }
      })

      expect(atResume).toHaveLength(1)
      expect(atResume[0]!.types).toEqual(["flows.engine.deferred-completed"])
      expect(Option.getOrThrow(atResume[0]!.row).metadata).toEqual({ correlationId: "opaque" })
      expect(resumes).toEqual(["ordered:deferred"])
    })))

  it.effect("completes nothing, journals nothing and resumes nothing for a run that does not exist", () =>
    run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const address = { flowName: TestFlow._tag, executionId: "never-started", deferredName: "answer" }

      const service = yield* build(resumes)
      yield* service.deferredDone({ ...address, exit: Exit.succeed("early") })

      expect(yield* recorded("never-started")).toEqual([])
      expect(resumes).toEqual([])
      expect(Option.isNone(yield* state.deferred(address))).toBe(true)
    })))

  it.effect("refuses a clock schedule from a process that does not own the run, and records nothing", () =>
    run(Effect.gen(function*() {
      yield* owned("foreign-clock")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const stranger = yield* build(resumes, { owner: { ...owner, nonce: "stranger" } })
      const clock = DurableClock.make({ name: "foreign", duration: "1 second" })

      const exit = yield* Effect.exit(stranger.scheduleClock(TestFlow, { executionId: "foreign-clock", clock }))
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(
        Option.isNone(
          yield* state.clock({ flowName: TestFlow._tag, executionId: "foreign-clock", clockName: clock.name })
        )
      ).toBe(true)
      expect(yield* recorded("foreign-clock")).toEqual([])
      expect(resumes).toEqual([])
    })))

  it.effect("reads a completion from a fresh persistence instance", () =>
    run(Effect.gen(function*() {
      yield* owned("restart")
      const first = yield* build([])
      yield* first.deferredDone({
        flowName: TestFlow._tag,
        executionId: "restart",
        deferredName: "answer",
        exit: Exit.succeed("persisted")
      })

      const restarted = yield* build([], { state: yield* DurableEngineState.make })
      const result = yield* restarted.deferredResult(
        DurableDeferred.make("answer", {
          success: Schema.String
        })
      ).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(TestFlow, "restart"))
      )

      expect(Option.getOrThrow(result)).toEqual(Exit.succeed("persisted"))
      expect(yield* recorded("restart")).toEqual([
        "flows.engine.deferred-completed",
        "flows.engine.deferred-consumed"
      ])
    })))

  it.effect("re-arms a future clock after restart and fires its original deadline", () =>
    run(Effect.gen(function*() {
      yield* owned("clock-run")
      const resumes: Array<string> = []
      const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })

      yield* Effect.scoped(Effect.gen(function*() {
        const first = yield* build(resumes)
        yield* first.scheduleClock(TestFlow, {
          executionId: "clock-run",
          clock
        })
      }))
      yield* TestClock.adjust("5 seconds")

      const state = yield* DurableEngineState.make
      const restarted = yield* build(resumes, { state })
      yield* restarted.sweepDue(TestFlow._tag)
      const before = Option.getOrThrow(
        yield* state.clock({
          flowName: TestFlow._tag,
          executionId: "clock-run",
          clockName: "wake"
        })
      )

      yield* TestClock.adjust("4999 millis")
      yield* Effect.yieldNow
      const pending = Option.getOrThrow(yield* state.clock(before))
      yield* TestClock.adjust("1 millis")
      yield* TestDatabase.until(Effect.sync(() => resumes.length === 1))
      const after = Option.getOrThrow(yield* state.clock(before))

      expect(before.dueAtMs).toBe(10_000)
      expect(pending.completedAtMs).toBeNull()
      expect(after.completedAtMs).toBe(10_000)
      expect(resumes).toEqual(["clock-run:clock"])
      // The sweep re-announced the clock under the same source: one record.
      const types = yield* recorded("clock-run")
      expect(count(types, "flows.engine.clock-scheduled")).toBe(1)
      expect(count(types, "flows.engine.deferred-completed")).toBe(1)
      expect(count(types, "flows.engine.clock-completed")).toBe(1)
    })))

  it.effect("sweeps every named flow's clocks and completions after a restart with one read each, and no other's", () =>
    Effect.gen(function*() {
      const Other = Flow.make("DeferredPersistence/Other", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("unused")
      })
      const Unnamed = Flow.make("DeferredPersistence/Unnamed", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("unused")
      })
      yield* run(Effect.gen(function*() {
        for (const runId of ["clock-test", "clock-unnamed", "done-other", "done-unnamed"]) yield* owned(runId)
        const state = yield* DurableEngineState.DurableEngineState
        const resumes: Array<string> = []
        const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })

        yield* Effect.scoped(Effect.gen(function*() {
          const first = yield* build(resumes)
          yield* first.scheduleClock(TestFlow, { executionId: "clock-test", clock })
          yield* first.scheduleClock(Unnamed, { executionId: "clock-unnamed", clock })
          for (const [flow, executionId] of [[Other, "done-other"], [Unnamed, "done-unnamed"]] as const) {
            yield* state.completeDeferred({
              flowName: flow._tag,
              executionId,
              deferredName: "answer",
              exit: Exit.succeed("persisted"),
              completedAtMs: 0
            })
          }
        }))
        // The first incarnation's timers went with it.
        yield* TestClock.adjust("5 seconds")
        yield* Effect.yieldNow
        const beforeSweep = [...resumes]

        let reads = 0
        const fresh = yield* DurableEngineState.make
        const counted = DurableEngineState.DurableEngineState.of({
          ...fresh,
          pendingClocks: (scope) => Effect.andThen(Effect.sync(() => reads++), fresh.pendingClocks(scope)),
          completedDeferreds: (flowName, executionId) =>
            Effect.andThen(Effect.sync(() => reads++), fresh.completedDeferreds(flowName, executionId))
        })
        const restarted = yield* build(resumes, { state: counted })
        yield* restarted.sweepFlows(new Set([TestFlow._tag, Other._tag]))
        yield* Effect.yieldNow
        // Both clocks come due; only the named flow's was armed again.
        yield* TestClock.adjust("5 seconds")
        yield* Effect.yieldNow
        yield* TestDatabase.until(Effect.sync(() => resumes.length >= 2))
        yield* TestClock.adjust("1 second")
        yield* Effect.yieldNow

        expect(beforeSweep).toEqual([])
        expect([...resumes].sort()).toEqual(["clock-test:clock", "done-other:deferred"])
        expect(reads).toBe(2)
        expect(count(yield* recorded("clock-unnamed"), "flows.engine.deferred-completed")).toBe(0)
      }))
    }))

  it.effect("does not fire a clock again when a replayed sleep re-schedules it", () =>
    run(Effect.gen(function*() {
      yield* owned("replay-run")
      const resumes: Array<string> = []
      const service = yield* build(resumes)
      const clock = DurableClock.make({ name: "replayed", duration: "1 second" })
      yield* service.scheduleClock(TestFlow, { executionId: "replay-run", clock })
      yield* TestClock.adjust("1 second")
      yield* TestDatabase.until(Effect.sync(() => resumes.length === 1))
      const fired = [...resumes]
      // The woken run replays its sleep, which schedules the same clock
      // and gets the fired row back. Re-firing it would wake the run
      // again, and that replay would schedule it again, forever.
      yield* service.scheduleClock(TestFlow, { executionId: "replay-run", clock })
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow

      expect(fired).toEqual(["replay-run:clock"])
      expect(resumes).toEqual(["replay-run:clock"])
      expect(count(yield* recorded("replay-run"), "flows.engine.deferred-completed")).toBe(1)
    })))

  it.effect("redispatches a clock fire with backoff after a transient journal failure instead of losing the timer", () =>
    run(Effect.gen(function*() {
      yield* owned("retry-run")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const sleeps = yield* observedSleeps
      // The first two durable emits at fire time die (e.g. SQLITE_BUSY
      // surfaced through the orDie journal path); the third succeeds.
      let failuresRemaining = 0
      let fireFailures = 0
      const base = yield* Journal.Journal
      const journal: Journal.Service = {
        ...base,
        emitDurableUnfenced: (input) =>
          Effect.suspend(() => {
            if (failuresRemaining > 0 && input.eventType === "flows.engine.deferred-completed") {
              failuresRemaining--
              fireFailures++
              return Effect.die(new Error("transient journal failure"))
            }
            return base.emitDurableUnfenced(input)
          })
      }
      const clock = DurableClock.make({ name: "retry", duration: "10 seconds" })
      const service = yield* build(resumes, { journal })
      yield* service.scheduleClock(TestFlow, { executionId: "retry-run", clock }).pipe(
        Effect.provideService(Clock.Clock, sleeps.clock)
      )
      yield* sleeps.waitFor(10_000)
      failuresRemaining = 2
      const address = {
        flowName: TestFlow._tag,
        executionId: "retry-run",
        clockName: "retry"
      }

      yield* TestClock.adjust("10 seconds")
      yield* TestDatabase.until(Effect.sync(() => fireFailures === 1))
      yield* sleeps.waitFor(100)
      // First fire failed at the journal; without redispatch the timer
      // fiber is dead and the clock row never completes in this process.
      const afterFirstFailure = Option.getOrThrow(yield* state.clock(address))
      yield* TestClock.adjust("100 millis")
      yield* TestDatabase.until(Effect.sync(() => fireFailures === 2))
      yield* sleeps.waitFor(200)
      const afterSecondFailure = Option.getOrThrow(yield* state.clock(address))
      yield* TestClock.adjust("200 millis")
      yield* TestDatabase.until(Effect.sync(() => resumes.length === 1))
      const afterRetry = Option.getOrThrow(yield* state.clock(address))

      expect(fireFailures).toBe(2)
      expect(afterFirstFailure.completedAtMs).toBeNull()
      expect(afterSecondFailure.completedAtMs).toBeNull()
      expect(afterRetry.completedAtMs).not.toBeNull()
      expect(resumes).toEqual(["retry-run:clock"])
      // The failed fires rolled back with their transaction: one completion record.
      expect(count(yield* recorded("retry-run"), "flows.engine.deferred-completed")).toBe(1)
    })))

  it.effect("redispatches on a supplied policy instead of the default backoff", () =>
    run(Effect.gen(function*() {
      // The default ladder starts at 100ms (`defaultFireRetryPolicy`); this
      // composition supplies a flat 5s one instead, so the redispatch that the
      // test above observed after 100ms must not have happened yet at 4999ms.
      yield* owned("slow-retry-run")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const sleeps = yield* observedSleeps
      let failuresRemaining = 0
      let fireFailures = 0
      const base = yield* Journal.Journal
      const journal: Journal.Service = {
        ...base,
        emitDurableUnfenced: (input) =>
          Effect.suspend(() => {
            if (failuresRemaining > 0 && input.eventType === "flows.engine.deferred-completed") {
              failuresRemaining--
              fireFailures++
              return Effect.die(new Error("transient journal failure"))
            }
            return base.emitDurableUnfenced(input)
          })
      }
      const clock = DurableClock.make({ name: "slow-retry", duration: "10 seconds" })
      const service = yield* build(resumes, { journal, fireRetryPolicy: Schedule.spaced("5 seconds") })
      yield* service.scheduleClock(TestFlow, { executionId: "slow-retry-run", clock }).pipe(
        Effect.provideService(Clock.Clock, sleeps.clock)
      )
      yield* sleeps.waitFor(10_000)
      failuresRemaining = 1
      const address = {
        flowName: TestFlow._tag,
        executionId: "slow-retry-run",
        clockName: "slow-retry"
      }

      yield* TestClock.adjust("10 seconds")
      yield* TestDatabase.until(Effect.sync(() => fireFailures === 1))
      yield* sleeps.waitFor(5_000)
      yield* TestClock.adjust("4999 millis")
      yield* Effect.yieldNow
      const beforeSuppliedDelay = Option.getOrThrow(yield* state.clock(address))
      yield* TestClock.adjust("1 millis")
      yield* TestDatabase.until(Effect.sync(() => resumes.length === 1))
      const afterSuppliedDelay = Option.getOrThrow(yield* state.clock(address))

      expect(beforeSuppliedDelay.completedAtMs).toBeNull()
      expect(afterSuppliedDelay.completedAtMs).not.toBeNull()
      expect(resumes).toEqual(["slow-retry-run:clock"])
    })))

  it.effect("delivers deferred completions and clock fires while the lossy sink failure is latched", () =>
    run(Effect.gen(function*() {
      // Issue #43: SqlJournal latches `sinkFailure` forever after one lossy
      // writer error, so `flush` fails on every subsequent call while
      // `emitDurable` keeps committing. Durable delivery must survive that.
      yield* owned("latched-run")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      let flushFailures = 0
      const base = yield* Journal.Journal
      const journal: Journal.Service = {
        ...base,
        flush: Effect.suspend(() => {
          flushFailures++
          return Effect.fail(
            new Journal.JournalError({
              code: "sink_failed",
              message: "journal sink failed"
            })
          )
        })
      }
      const service = yield* build(resumes, { journal })

      const deferredAddress = {
        flowName: TestFlow._tag,
        executionId: "latched-run",
        deferredName: "answer"
      }
      yield* service.deferredDone({
        ...deferredAddress,
        exit: Exit.succeed("still delivered")
      })
      const deferredRow = Option.getOrThrow(yield* state.deferred(deferredAddress))

      const clock = DurableClock.make({ name: "latched", duration: "10 seconds" })
      yield* service.scheduleClock(TestFlow, { executionId: "latched-run", clock })
      yield* TestClock.adjust("10 seconds")
      yield* TestDatabase.until(Effect.sync(() => resumes.length === 2))
      const clockRow = Option.getOrThrow(
        yield* state.clock({
          flowName: TestFlow._tag,
          executionId: "latched-run",
          clockName: "latched"
        })
      )

      // Every flush attempt failed with the latched sink error...
      expect(flushFailures).toBeGreaterThanOrEqual(3)
      // ...yet the durable channel committed and delivery still happened.
      expect(deferredRow.exit).toEqual(Exit.succeed("still delivered"))
      expect(clockRow.completedAtMs).not.toBeNull()
      const types = yield* recorded("latched-run")
      expect(types).toContain("flows.engine.deferred-completed")
      expect(types).toContain("flows.engine.clock-scheduled")
      expect(resumes).toEqual(["latched-run:deferred", "latched-run:clock"])
    })))

  it.effect("re-delivers a wake for a completion recorded before registration", () =>
    run(Effect.gen(function*() {
      yield* owned("completion-during-downtime")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      yield* state.completeDeferred({
        flowName: TestFlow._tag,
        executionId: "completion-during-downtime",
        deferredName: "answer",
        exit: Exit.succeed("ready"),
        completedAtMs: 1
      })
      const restarted = yield* build(resumes, { state: yield* DurableEngineState.make })
      yield* restarted.sweepDue(TestFlow._tag)

      expect(resumes).toEqual(["completion-during-downtime:deferred"])
    })))

  it.effect("stops sweeping a completion once deferredResult has served it", () =>
    run(Effect.gen(function*() {
      yield* owned("consumed-completion")
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const service = yield* build(resumes)
      const address = {
        flowName: TestFlow._tag,
        executionId: "consumed-completion",
        deferredName: "answer"
      }
      const deferred = DurableDeferred.make("answer", { success: Schema.String })
      const result = service.deferredResult(deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(TestFlow, address.executionId))
      )
      expect(yield* result).toEqual(Option.none())
      yield* state.completeDeferred({ ...address, exit: Exit.succeed("ready"), completedAtMs: 1 })
      yield* service.sweepDue(TestFlow._tag)
      expect(resumes).toEqual(["consumed-completion:deferred"])
      expect(yield* result).toEqual(Option.some(Exit.succeed("ready")))
      // Point reads and replay retain the first result, including after a
      // duplicate completion. Neither operation re-arms registration recovery.
      yield* state.completeDeferred({ ...address, exit: Exit.succeed("duplicate"), completedAtMs: 2 })
      expect(yield* result).toEqual(Option.some(Exit.succeed("ready")))
      const restarted = yield* build(resumes, { state: yield* DurableEngineState.make })
      yield* restarted.sweepDue(TestFlow._tag)
      expect(resumes).toEqual(["consumed-completion:deferred"])
      expect(count(yield* recorded("consumed-completion"), "flows.engine.deferred-consumed")).toBe(1)
    })))

  it.effect("uses one stable wake identity across repeated registration sweeps", () =>
    run(Effect.gen(function*() {
      yield* owned("historical-completion")
      const state = yield* DurableEngineState.DurableEngineState
      const sourceIds: Array<string> = []
      yield* state.completeDeferred({
        flowName: TestFlow._tag,
        executionId: "historical-completion",
        deferredName: "answer",
        exit: Exit.succeed("ready"),
        completedAtMs: 1
      })
      const service = yield* DeferredPersistence.make({
        owner,
        journalSource: "deferred-test",
        scheduleResume: (_flowName, _executionId, _reason, sourceId) => Effect.sync(() => sourceIds.push(sourceId!))
      })
      yield* service.sweepDue(TestFlow._tag)
      yield* service.sweepDue(TestFlow._tag)

      expect(sourceIds).toEqual([
        "deferred-test:wake:[\"DeferredPersistence/Test\",\"historical-completion\",\"answer\"]",
        "deferred-test:wake:[\"DeferredPersistence/Test\",\"historical-completion\",\"answer\"]"
      ])
    })))
})

describe("active-wait deferred admission on SQL", () => {
  it.effect("commits only the exact parked token, with its record, across fresh persistence instances", () =>
    run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const resumes: Array<string> = []
      const service = yield* build(resumes)
      const runId = "sql-approval-cas"
      const unopenedRunId = "sql-unopened-cas"
      yield* owned(runId)
      yield* owned(unopenedRunId)
      yield* state.park(runId, { reason: "approval", token: "attempt-1" }, owner)

      const base = {
        flowName: TestFlow._tag,
        executionId: runId,
        deferredName: "answer",
        reason: "approval",
        token: "attempt-1",
        exit: Exit.succeed("accepted")
      }
      const wrong = yield* service.deferredDoneIfWaiting({ ...base, token: "other" })
      const duplicates = yield* Effect.all([
        service.deferredDoneIfWaiting(base),
        service.deferredDoneIfWaiting({ ...base, exit: Exit.succeed("duplicate") })
      ], { concurrency: "unbounded" })
      const unopened = yield* service.deferredDoneIfWaiting({
        ...base,
        executionId: unopenedRunId
      })

      const restarted = yield* DurableEngineState.make
      expect(wrong).toBe("NotWaiting")
      expect([...duplicates].sort()).toEqual(["Completed", "Existing"])
      expect(unopened).toBe("NotWaiting")
      expect([Exit.succeed("accepted"), Exit.succeed("duplicate")]).toContainEqual(
        Option.getOrThrow(yield* restarted.deferred(base)).exit
      )
      expect(Option.isNone(yield* restarted.deferred({ ...base, executionId: unopenedRunId }))).toBe(true)
      // The row and its record committed together; the refused admissions left neither.
      expect(yield* recorded(runId)).toEqual(["flows.engine.deferred-completed"])
      expect(yield* recorded(unopenedRunId)).toEqual([])
      expect(resumes).toHaveLength(2)
    })))
})

/**
 * B-08: the blast radius of a corrupt row must be that row.
 *
 * `completedDeferreds` and `pendingClocks` decoded their whole batch through
 * `Effect.orDie`, and `register` sweeps both. One unreadable row anywhere in a
 * flow's history therefore killed every registration of that flow in every
 * process: the registration died, so nothing was registered, so no run of that
 * flow ever resumed again — an operator-visible outage caused by a single row
 * nothing was going to act on anyway.
 *
 * The rows are written straight through SQL because that is the only way to
 * produce the shape: the service's own writers cannot emit one, and the point
 * is what the reader does with a row it did not write.
 */
describe("a malformed sweep row is skipped, not fatal (B-08)", () => {
  const sqliteDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.sqliteLayer)

  /** A run row, so the sweep's run-status join has something live to find. */
  const seedRun = (sql: SqlClient.SqlClient, runId: string) =>
    sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES (${runId}, 'suspended', 0, '{}')
    `.pipe(Effect.orDie, Effect.asVoid)

  it.effect("registration still sweeps every readable row, and says which row it dropped", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const capture = Logger.make((options) => {
        logs.push(String(options.message))
      })
      const resumes: Array<string> = []

      const swept = yield* run(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const state = yield* DurableEngineState.DurableEngineState
          yield* seedRun(sql, "readable-run")
          yield* seedRun(sql, "corrupt-run")

          // Readable rows: one completion and one pending clock.
          yield* state.completeDeferred({
            flowName: TestFlow._tag,
            executionId: "readable-run",
            deferredName: "answer",
            exit: Exit.succeed("ready"),
            completedAtMs: 1
          })
          yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES (${TestFlow._tag}, 'readable-run', 'readable-clock', 'answer', 60000, NULL)
          `.pipe(Effect.orDie)

          // The corrupt pair. A BLOB satisfies the table's `length(...) > 0`
          // check and its TEXT affinity — SQLite does not coerce a blob — and
          // fails the row schema, which is what a page-level corruption or a
          // foreign writer leaves behind.
          yield* sql`
            INSERT INTO flows_deferred_completions
              (flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms)
            VALUES (${TestFlow._tag}, 'corrupt-run', x'00ff', '{}', NULL, 1)
          `.pipe(Effect.orDie)
          yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES (${TestFlow._tag}, 'corrupt-run', x'00ff', 'answer', 60000, NULL)
          `.pipe(Effect.orDie)

          const service = yield* build(resumes)
          yield* service.sweepDue(TestFlow._tag)
          return { readable: yield* recorded("readable-run"), corrupt: yield* recorded("corrupt-run") }
        }).pipe(Effect.provide(Logger.layer([capture]))),
        sqliteDatabase
      )

      // The registration survived, and every readable row was swept.
      expect(resumes).toEqual(["readable-run:deferred"])
      expect(swept.readable).toEqual(["flows.engine.clock-scheduled"])
      expect(swept.corrupt).toEqual([])
      // Both corrupt rows are named by their primary key, which is what an
      // operator needs to find and repair them.
      const warnings = logs.filter((message) => message.includes("malformed"))
      expect(warnings).toHaveLength(2)
      expect(warnings.some((message) => message.includes("deferred completion") && message.includes("corrupt-run")))
        .toBe(true)
      expect(warnings.some((message) => message.includes("clock deadline") && message.includes("corrupt-run"))).toBe(
        true
      )
    }))
})
