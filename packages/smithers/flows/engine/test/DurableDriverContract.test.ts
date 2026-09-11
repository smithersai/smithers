/**
 * The durable-driver contract, proved over a persistent `Encoded` fixture
 * rather than a scripted log: an engine instance is killed mid-run and a
 * SECOND instance is built over the same durable log, which must then resume
 * without duplicating keyed side effects, preserve the retry origin and
 * attempt numbering, deliver child cancellations over the persisted parent
 * edges, and answer polls coherently.
 *
 * Process death is modeled as discarding one engine instance (closing its
 * provide scope kills every in-process fiber) and constructing a fresh
 * instance over the same {@link DurableLog} — the process-restart shape,
 * without real process boundaries. See `DurableLogEngine.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"
import { pollUntil } from "./Harness.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

/** Yields until the predicate holds, bounded by scheduler turns. */
const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let index = 0; index < 200 && !predicate(); index++) {
      yield* Effect.yieldNow
    }
  })

describe("durable driver contract across an engine restart", () => {
  effect("replays a keyed side effect recorded before the crash instead of re-executing it", () => {
    const log = makeLog()
    let charges = 0
    const gate = DurableDeferred.make("DurableContract/restart-gate", { success: Schema.Number })
    const charge = Action.make({
      name: "DurableContract/charge",
      success: Schema.Number,
      idempotencyKey: "durable-contract/charge",
      execute: Effect.sync(() => ++charges)
    })
    const stepDeclaration = Action.make("DurableContract/restart/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("DurableContract/restart", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => stepDeclaration.call(payload)
    })
    const stack = Layer.mergeAll(
      stepDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const charged = yield* charge
          const woken = yield* DurableDeferred.await(gate)
          return charged * 100 + woken
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerDurable(log))
    )

    return Effect.gen(function*() {
      // Engine instance 1: the keyed side effect runs, its outcome is
      // journaled, and the run parks. The instance is then discarded with
      // the run still open.
      yield* Effect.gen(function*() {
        yield* flow.execute({ id: "x" }, { executionId: "restart-run", discard: true })
        const parked = yield* pollUntil(flow.poll("restart-run"), (result) => result._tag === "Suspended", {
          turns: 100
        })
        expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
        expect(charges).toBe(1)
      }).pipe(Effect.provide(stack))

      // Engine instance 2, over the same log.
      yield* Effect.gen(function*() {
        // Poll is coherent across the restart: the parked settlement
        // survives before anything is re-driven.
        const parked = yield* flow.poll("restart-run")
        expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")

        const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId: "restart-run" })
        yield* DurableDeferred.succeed(gate, { token, value: 7 })
        const woken = yield* pollUntil(flow.poll("restart-run"), (result) => result._tag === "Complete", { turns: 100 })
        expect(
          Option.isSome(woken) && woken.value._tag === "Complete" &&
            Exit.isSuccess(woken.value.exit) && woken.value.exit.value
        ).toBe(107)
        // The keyed side effect was recorded once and replayed, never re-run.
        expect(charges).toBe(1)
        // A repeat execute of the settled run answers from the journal.
        expect(yield* flow.execute({ id: "x" }, { executionId: "restart-run" })).toBe(107)
        expect(charges).toBe(1)
      }).pipe(Effect.provide(stack))
    })
  })

  effect("resumes the persisted attempt numbering instead of restarting the backoff ladder", () => {
    const log = makeLog()
    const dispatched: Array<number> = []
    const wobbly = Action.make({
      name: "DurableContract/wobbly",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "durable-contract/wobbly",
      retryPolicy: RetryPolicy.make({ initialMs: 10_000, factor: 1, maxMs: 10_000, maxAttempts: 5 }),
      execute: Effect.gen(function*() {
        const attempt = yield* Action.CurrentAttempt
        dispatched.push(attempt)
        return attempt < 3 ? yield* Effect.fail("flaky") : attempt
      })
    })
    const stepDeclaration = Action.make("DurableContract/attempts/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("DurableContract/attempts", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => stepDeclaration.call(payload)
    })
    const stack = Layer.mergeAll(
      stepDeclaration.toLayer(() => wobbly),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerDurable(log))
    )

    return Effect.gen(function*() {
      // Engine instance 1: attempts 1 and 2 dispatch and fail; the instance
      // dies mid-backoff, before attempt 3.
      yield* Effect.gen(function*() {
        yield* flow.execute({ id: "x" }, { executionId: "attempts-run", discard: true })
        yield* waitFor(() => dispatched.length === 1)
        for (let index = 0; index < 50 && dispatched.length < 2; index++) {
          yield* Effect.yieldNow
          yield* TestClock.adjust("10 seconds")
        }
        expect(dispatched).toEqual([1, 2])
      }).pipe(Effect.provide(stack))

      // Engine instance 2: the persisted sequence resumes at the recorded
      // attempt. Attempts 1 and 2 replay from their journaled failures —
      // neither is re-dispatched, and their backoff is not re-slept from
      // attempt 1 — then attempt 3 dispatches once and settles the run.
      yield* Effect.gen(function*() {
        yield* flow.execute({ id: "x" }, { executionId: "attempts-run", discard: true })
        for (let index = 0; index < 50 && dispatched.length < 3; index++) {
          yield* Effect.yieldNow
          yield* TestClock.adjust("10 seconds")
        }
        const settled = yield* pollUntil(flow.poll("attempts-run"), (result) => result._tag === "Complete", {
          turns: 100
        })
        expect(
          Option.isSome(settled) && settled.value._tag === "Complete" &&
            Exit.isSuccess(settled.value.exit) && settled.value.exit.value
        ).toBe(3)
        expect(dispatched).toEqual([1, 2, 3])
      }).pipe(Effect.provide(stack))
    })
  })

  effect("restores the pre-crash snapshot and skips boundaries on journal replay", () => {
    const log = makeLog()
    const events: Array<string> = []
    const started: Array<number> = []
    const snapshots = new Map<string, number>()
    let world = 0
    let serial = 0
    const step = Action.make({
      name: "DurableContract/compensable",
      tier: "compensable",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 10_000, factor: 1, maxMs: 10_000, maxAttempts: 3 }),
      execute: Effect.gen(function*() {
        const attempt = yield* Action.CurrentAttempt
        const key = yield* Action.CurrentInvocationKey
        expect(log.attempts.get(key!)?.snapshots?.get(attempt)).toBe(`handle-${attempt}`)
        started.push(world)
        events.push(`execute:${attempt}`)
        world++
        return attempt < 3 ? yield* Effect.fail("retry") : world
      })
    })
    const declaration = Action.make("DurableContract/compensable/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("DurableContract/compensable", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => declaration.call(payload)
    })
    const boundary = FlowEngine.SnapshotBoundary.of({
      snapshot: ({ attempt }) =>
        Effect.sync(() => {
          const handle = `handle-${++serial}`
          snapshots.set(handle, world)
          events.push(`snapshot:${attempt}:${handle}`)
          return handle
        }),
      restore: (handle, { attempt }) =>
        Effect.sync(() => {
          events.push(`restore:${attempt}:${String(handle)}`)
          world = snapshots.get(handle as string)!
        }),
      diff: (handle, { attempt }) =>
        Effect.sync(() => {
          events.push(`diff:${attempt}:${String(handle)}`)
        })
    })
    const stack = Layer.mergeAll(declaration.toLayer(() => step), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerDurable(log)),
      Layer.provideMerge(Layer.succeed(FlowEngine.SnapshotBoundary)(boundary))
    )

    return Effect.gen(function*() {
      // Close each engine during backoff. Only the durable log and the host's
      // world/snapshot storage survive; snapshot handles are never reused.
      for (let attempt = 1; attempt <= 3; attempt++) {
        yield* Effect.gen(function*() {
          yield* flow.execute({ id: "x" }, { executionId: "compensable-run", discard: true })
          for (let index = 0; index < 50 && started.length < attempt; index++) {
            yield* Effect.yieldNow
            if (attempt > 1) yield* TestClock.adjust("10 seconds")
          }
          yield* waitFor(() => events.includes(`diff:${attempt}:handle-${attempt}`))
          expect(started).toEqual(Array(attempt).fill(0))
          expect(world).toBe(1)
          if (attempt === 3) {
            const settled = yield* pollUntil(flow.poll("compensable-run"), (result) => result._tag === "Complete", {
              turns: 100
            })
            expect(
              Option.isSome(settled) && settled.value._tag === "Complete" &&
                Exit.isSuccess(settled.value.exit) && settled.value.exit.value
            ).toBe(1)
          }
        }).pipe(Effect.provide(stack))
      }
      expect(events).toEqual([
        "snapshot:1:handle-1",
        "execute:1",
        "diff:1:handle-1",
        "restore:2:handle-1",
        "snapshot:2:handle-2",
        "execute:2",
        "diff:2:handle-2",
        "restore:3:handle-1",
        "snapshot:3:handle-3",
        "execute:3",
        "diff:3:handle-3"
      ])
    })
  })

  effect("decides the schedule-to-close budget against the durable retry origin after a restart", () => {
    const log = makeLog()
    const dispatched: Array<number> = []
    const expiring = Action.make({
      name: "DurableContract/expiring",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "durable-contract/expiring",
      retryPolicy: RetryPolicy.make({
        initialMs: 1000,
        factor: 1,
        maxMs: 1000,
        maxAttempts: 10,
        expirationMs: 30_000
      }),
      execute: Effect.gen(function*() {
        dispatched.push(yield* Action.CurrentAttempt)
        return yield* Effect.fail("still-broken")
      })
    })
    const stepDeclaration = Action.make("DurableContract/expiring/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("DurableContract/expiring", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => stepDeclaration.call(payload)
    })
    const stack = Layer.mergeAll(
      stepDeclaration.toLayer(() => expiring),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerDurable(log))
    )

    return Effect.gen(function*() {
      // Engine instance 1: attempt 1 dispatches at T0 — the durable origin —
      // and fails; the instance dies mid-backoff.
      yield* Effect.gen(function*() {
        yield* flow.execute({ id: "x" }, { executionId: "expiring-run", discard: true })
        yield* waitFor(() => dispatched.length === 1)
        expect(dispatched).toEqual([1])
      }).pipe(Effect.provide(stack))

      // The process is down while the wall clock passes the budget.
      yield* TestClock.adjust("60 seconds")

      // Engine instance 2: the replayed attempt-1 failure is decided against
      // the PERSISTED origin — 60s elapsed against a 30s budget — so the run
      // settles with the typed expiration (captured as the round's defect,
      // `CaptureDefects` defaults on) instead of re-entering the ladder. Had
      // the origin restarted from the current clock, the decision would have
      // been RetryAfter and attempt 2 would have dispatched.
      yield* Effect.gen(function*() {
        yield* flow.execute({ id: "x" }, { executionId: "expiring-run", discard: true })
        const settled = yield* pollUntil(flow.poll("expiring-run"), (result) => result._tag === "Complete", {
          turns: 100
        })
        expect(Option.isSome(settled) && settled.value._tag).toBe("Complete")
        const exit = Option.isSome(settled) && settled.value._tag === "Complete"
          ? settled.value.exit
          : undefined
        expect(exit !== undefined && Exit.isFailure(exit)).toBe(true)
        const defect = exit !== undefined && Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(defect).toBe("still-broken")
        // Replay only: the restarted engine never re-dispatched the attempt.
        expect(dispatched).toEqual([1])
      }).pipe(Effect.provide(stack))
    })
  })

  effect("cascades a cancel request over the persisted parent edge after a restart", () => {
    const log = makeLog()
    const childGate = DurableDeferred.make("DurableContract/child-gate", { success: Schema.Number })
    const childStepDeclaration = Action.make("DurableContract/cascade-child/action", {
      payload: { n: Schema.Number },
      success: Schema.Number
    })
    const child = Flow.make("DurableContract/cascade-child", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      body: (payload) => childStepDeclaration.call(payload)
    })
    const parentStepDeclaration = Action.make("DurableContract/cascade-parent/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const parent = Flow.make("DurableContract/cascade-parent", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => parentStepDeclaration.call(payload)
    })
    const stack = Layer.mergeAll(
      // The literal child payload always satisfies its schema, so the typed
      // SchemaError on execute cannot occur and is disposed of as a defect.
      parentStepDeclaration.toLayer(() => Effect.orDie(child.execute({ n: 1 }, { executionId: "cascade-child" }))),
      Interpreter.layer(parent)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        Layer.mergeAll(
          childStepDeclaration.toLayer(() => DurableDeferred.await(childGate)),
          Interpreter.layer(child)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      ),
      Layer.provideMerge(layerDurable(log))
    )

    return Effect.gen(function*() {
      // Engine instance 1: the parent opens the child (persisting the parent
      // edge), the child parks on its gate, the parent parks behind the
      // child, and the instance dies.
      yield* Effect.gen(function*() {
        yield* parent.execute({ id: "x" }, { executionId: "cascade-parent", discard: true })
        const parked = yield* pollUntil(parent.poll("cascade-parent"), (result) => result._tag === "Suspended", {
          turns: 100
        })
        expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
        expect(log.parents.get("cascade-child")).toBe("cascade-parent")
      }).pipe(Effect.provide(stack))

      // Engine instance 2: cancelling the parent must reach the child over
      // the persisted edge — the in-process parent link died with instance 1.
      yield* Effect.gen(function*() {
        yield* parent.interrupt("cascade-parent")
        expect(log.cancelled.has("cascade-parent")).toBe(true)
        expect(log.cancelled.has("cascade-child")).toBe(true)

        const childResult = yield* pollUntil(child.poll("cascade-child"), (result) => result._tag === "Complete", {
          turns: 100
        })
        expect(Option.isSome(childResult) && childResult.value._tag).toBe("Complete")
        const childExit = Option.isSome(childResult) && childResult.value._tag === "Complete"
          ? childResult.value.exit
          : undefined
        // The child was cancelled, not answered: its gate never resolved.
        expect(childExit !== undefined && Exit.isFailure(childExit)).toBe(true)
        expect(
          childExit !== undefined && Exit.isFailure(childExit) &&
            childExit.cause.reasons.some(Cause.isInterruptReason)
        ).toBe(true)

        const parentResult = yield* pollUntil(parent.poll("cascade-parent"), (result) => result._tag === "Complete", {
          turns: 100
        })
        expect(Option.isSome(parentResult) && parentResult.value._tag).toBe("Complete")
        const parentExit = Option.isSome(parentResult) && parentResult.value._tag === "Complete"
          ? parentResult.value.exit
          : undefined
        expect(parentExit !== undefined && Exit.isFailure(parentExit)).toBe(true)
      }).pipe(Effect.provide(stack))
    })
  })
})

describe("durable driver refusals", () => {
  effect("dies with the typed FlowNotRegistered refusal for an unregistered flow", () => {
    const log = makeLog()
    const unregistered = Flow.make("DurableContract/unregistered", {
      payload: {},
      success: Schema.Void,
      body: () => {
        throw new Error("not executed")
      }
    })
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const exit = yield* Effect.exit(
        engine.execute(unregistered, { executionId: "unregistered", payload: {}, discard: true })
      )
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.FlowNotRegistered)
      expect(defect).toMatchObject({ code: "flow_not_registered", flowName: "DurableContract/unregistered" })
    }).pipe(Effect.scoped, Effect.provide(layerDurable(log)))
  })

  effect("dies with the typed ExecutionIdentityConflict for a deferred addressed to another flow", () => {
    const log = makeLog()
    const gate = DurableDeferred.make("DurableContract/refusal-gate", { success: Schema.String })
    const make = (name: string) =>
      Flow.make(name, {
        payload: {},
        success: Schema.Void,
        body: () => {
          throw new Error("not executed")
        }
      })
    const Known = make("DurableContract/KnownFlow")
    const Other = make("DurableContract/OtherFlow")
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(Known, () => Effect.succeed(undefined))
      yield* engine.execute(Known, { executionId: "known-flow", payload: {}, discard: true })
      const exit = yield* Effect.exit(engine.deferredDone(gate, {
        flowName: Other._tag,
        executionId: "known-flow",
        deferredName: gate.name,
        exit: Exit.succeed("wrong-flow")
      }))
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
      expect(defect).toMatchObject({
        code: "execution_identity_conflict",
        field: "flow",
        expected: "DurableContract/KnownFlow",
        actual: "DurableContract/OtherFlow"
      })
    }).pipe(Effect.scoped, Effect.provide(layerDurable(log)))
  })
})
