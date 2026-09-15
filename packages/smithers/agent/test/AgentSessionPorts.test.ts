/**
 * The two executor ports that have to reach the engine to mean anything.
 *
 * `Control.cancel` and `Control.signal` are control-plane records until
 * something writes them onto the engine. `AgentSession` is the production
 * `ControlExecutor`, so it is where that happens: a cancel becomes
 * `cancel_requested_at_ms` on the engine row — durable, and readable by
 * whichever process owns the run — and a signal completes the `WaitFor` wait
 * point the parked run declared, through the ordinary
 * `DurableDeferred.succeed` path.
 *
 * Everything here runs against the real durable engine over real SQLite. The
 * ports read and write engine rows, and a double for those rows would prove the
 * shape of a fixture rather than the behavior of a store.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { PersistenceError } from "@smthrs/control/ControlError"
import * as ControlRuntimeModule from "@smthrs/control/ControlRuntime"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { Envelope, Principal } from "@smthrs/control/ControlSchema"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import * as Jj from "@smthrs/kernel/Jj"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Clock, type Crypto, Effect, Exit, Layer, Option, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { fileBundle } from "../../control/test/DurableStack.ts"
import * as AgentSession from "../src/AgentSession.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const principal: Principal = { id: "operator", kind: "test", stampedAt: 0 }

/** One step before the wait, so the wake replays a settled prefix. */
const Mark = Action.make("agent/test/ports/mark", { payload: {}, success: Schema.String })

const Gated = Flow.make("agent/test/ports/gated", {
  payload: { name: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: ({ name }) =>
    Mark.call({}).pipe(
      Node.bindPlanned(() => WaitFor.action.call({ name }))
    )
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "agent-session-ports" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * The production durable engine over one in-memory SQLite database, with the
 * stores kept in the output because the ports read them.
 */
const makeStack = (
  controlLayer: Layer.Layer<ControlRuntime, never, Crypto.Crypto> = ControlRuntimeModule.layerMemory({
    flows: [{ flowId: "system/test", description: "test", deployClass: false, envelope }]
  }),
  engineFilename = ":memory:"
) =>
  Layer.mergeAll(
    Mark.toLayer(() => Effect.succeed("before")),
    WaitFor.layer,
    Interpreter.layer(Gated),
    Layer.fresh(controlLayer)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId: "agent-session-ports" },
        journalSource: "agent-session-ports",
        isAlive: () => Effect.succeed(false)
      })
    ),
    Layer.provideMerge(StepBoundary.layerTest()),
    // `layerAt` rather than `layer`: it keeps `DurableEngineState` in the
    // output, and the signal bridge reads the waiting row through it.
    Layer.provideMerge(TestStores.layerAt(engineFilename)),
    Layer.provideMerge(Layer.merge(Layer.succeed(Jj.Jj)(jj), NodeCrypto.layer))
  )

const stack = makeStack()

const run = <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(body, stack as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie)
  )

/** Plans, approves, and launches one control run through the port itself. */
const startControlRun = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const { card } = yield* runtime.plan({ flowId: "system/test", input: { suite: "ports" } })
  const token = yield* runtime.lookupApproval(card.approval.target)
  yield* runtime.installBulkGrant(token, card.envelope, "run")
  yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
  const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
  if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
  return launched.run.runId
})

/** Starts the gated flow and returns once the engine has parked it. */
const parkedRun = (runId: string, name: string) =>
  Effect.gen(function*() {
    yield* Gated.execute({ name }, { executionId: runId, discard: true })
    const state = yield* DurableEngineState.DurableEngineState
    const waiting = yield* state.waiting(runId)
    if (Option.isNone(waiting)) return yield* Effect.die(`run ${runId} did not park`)
    return waiting.value
  })

/** The run's store status right now, without waiting for it to move. */
const statusOf = (runId: string): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.map(Effect.flatMap(RunStore.RunStore, (store) => store.get(runId)), (row) => row.status)

/** Waits through resumed execution until the run settles, with a bounded poll. */
const settled = (runId: string, attempts = 2_000): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const row = yield* store.get(runId)
    if (!["pending", "running", "suspended"].includes(row.status) || attempts <= 0) return row.status
    yield* Effect.yieldNow
    return yield* settled(runId, attempts - 1)
  })

describe("AgentSession.requestCancel", () => {
  it("observes and cancels the current handoff round through the original run ID", async () => {
    await run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const owner = { hostId: "handoff-ports", pid: 1, nonce: "handoff-ports" }
      yield* store.create("ports-root", "{}", { lineageId: "ports-root", roundOrdinal: 0 })
      yield* store.claimAndOwn(
        "ports-root",
        { status: "pending", owner: null, heartbeatAtMs: null },
        owner,
        yield* Clock.currentTimeMillis
      )
      yield* store.create("ports-next", "{}", { parentRunId: "ports-root", lineageId: "ports-root", roundOrdinal: 1 })
      yield* store.transitionOwned("ports-root", owner, "completed", "{}")
      expect(yield* AgentSession.readExecution("ports-root")).toMatchObject({
        _tag: "Observed",
        status: "accepted",
        lineageId: "ports-root",
        roundOrdinal: 0,
        parentRunId: undefined
      })
      expect(yield* AgentSession.requestCancel({ runId: "ports-root" })).toBe("recorded")
      expect((yield* store.get("ports-next")).cancelRequestedAtMs).not.toBeNull()
      expect(yield* AgentSession.requestCancel({ runId: "ports-root" })).toBe("already-requested")
      expect((yield* store.get("ports-root")).status).toBe("completed")
    }))
  })

  it("records the cancellation on the engine row", async () => {
    const observed = await run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* parkedRun("ports-cancel", "approval")
      const before = yield* store.get("ports-cancel")

      const first = yield* AgentSession.requestCancel({ runId: "ports-cancel" })
      const after = yield* store.get("ports-cancel")
      // First-writer-wins: a second ask from a second process is not an error.
      const again = yield* AgentSession.requestCancel({ runId: "ports-cancel" })
      return { first, again, before, after, repeated: yield* store.get("ports-cancel") }
    }))

    expect(observed.before.cancelRequestedAtMs).toBeNull()
    expect(observed.first).toBe("recorded")
    expect(observed.after.cancelRequestedAtMs).not.toBeNull()
    // The repeat is accepted and changes nothing, and it says so: the port
    // reports which ask recorded the request, because `Control.cancel` keys its
    // attribution event on that and every repeat re-runs the whole mutation.
    expect(observed.again).toBe("already-requested")
    expect(observed.repeated.cancelRequestedAtMs).toBe(observed.after.cancelRequestedAtMs)
  })

  it("reports a settled engine row as terminal, and records nothing on it", async () => {
    const observed = await run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* parkedRun("ports-cancel-terminal", "approval")
      // Settle the run through the engine itself, so the terminal row is the
      // one the engine actually writes rather than a fixture.
      yield* AgentSession.deliverSignal({
        runId: "ports-cancel-terminal",
        signal: { name: "approval", payload: { approved: true } }
      })
      const status = yield* settled("ports-cancel-terminal")

      const record = yield* AgentSession.requestCancel({ runId: "ports-cancel-terminal" })
      return { status, record, row: yield* store.get("ports-cancel-terminal") }
    }))

    expect(observed.status).toBe("completed")
    // Not "recorded": nothing can act on a cancellation of a finished run, and
    // answering "recorded" let `Control.cancel` write a terminal control status
    // the engine row does not have (triage B-11).
    expect(observed.record).toEqual({ _tag: "Terminal", status: "completed" })
    expect(observed.row.cancelRequestedAtMs).toBeNull()
  })

  it("reports a run the engine never heard of as unknown, not as a failure", async () => {
    const observed = await run(AgentSession.requestCancel({ runId: "ports-absent" }))
    expect(observed).toBe("unknown")
  })

  it("records a cancellation against a clock the row can carry", async () => {
    const observed = await run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* parkedRun("ports-cancel-clock", "approval")
      const at = yield* Clock.currentTimeMillis
      yield* AgentSession.requestCancel({ runId: "ports-cancel-clock" })
      const row = yield* store.get("ports-cancel-clock")
      return { at, requested: row.cancelRequestedAtMs }
    }))

    expect(observed.requested).toBeGreaterThanOrEqual(observed.at)
  })
})

describe("AgentSession.deliverSignal", () => {
  it("completes the wait point the parked run declared and settles the run", async () => {
    const observed = await run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      yield* parkedRun("ports-signal", "approval")

      const delivery = yield* AgentSession.deliverSignal({
        runId: "ports-signal",
        signal: { name: "approval", payload: { approved: true } }
      })
      return {
        delivery,
        status: yield* settled("ports-signal"),
        stillWaiting: yield* state.waiting("ports-signal"),
        result: yield* Gated.poll("ports-signal")
      }
    }))

    expect(observed.delivery).toBe("delivered")
    expect(observed.status).toBe("completed")
    expect(Option.isNone(observed.stillWaiting)).toBe(true)
    // The node settles with the value that resolved the wait.
    const settledValue = Option.isSome(observed.result) && observed.result.value._tag === "Complete" &&
        Exit.isSuccess(observed.result.value.exit)
      ? observed.result.value.exit.value
      : undefined
    expect(settledValue).toEqual({ approved: true })
  })

  it("refuses a signal that names a different wait point", async () => {
    const observed = await run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      yield* parkedRun("ports-signal-other", "approval")
      const delivery = yield* AgentSession.deliverSignal({
        runId: "ports-signal-other",
        signal: { name: "shipped", payload: null }
      })
      return { delivery, stillWaiting: yield* state.waiting("ports-signal-other") }
    }))

    expect(observed.delivery).toBe("no-match")
    // Nothing was completed, so the run is exactly where it was.
    expect(Option.isSome(observed.stillWaiting)).toBe(true)
  })

  it("reports a run with no open wait point as unknown", async () => {
    const observed = await run(
      AgentSession.deliverSignal({ runId: "ports-signal-absent", signal: { name: "approval", payload: null } })
    )
    expect(observed).toBe("unknown")
  })
})

describe("AgentSession.drainRecordedSignals", () => {
  it("contains a pending-signal read failure without crashing executor startup", async () => {
    await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const failure = new PersistenceError({ operation: "pendingSignals", message: "injected read failure" })
      const exit = yield* AgentSession.drainRecordedSignals.pipe(
        Effect.provideService(ControlRuntime, { ...runtime, pendingSignals: Effect.fail(failure) }),
        Effect.exit
      )
      expect(exit._tag).toBe("Success")
    }))
  })

  it("delivers a signal recorded while no executor was running", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* startControlRun
      yield* parkedRun(runId, "approval")
      // What `Control.signal` writes when no executor can deliver it.
      yield* runtime.admitSignal("offline-approval", runId, { name: "approval", payload: { approved: true } })
      const beforeDrain = yield* statusOf(runId)

      yield* AgentSession.drainRecordedSignals
      return { beforeDrain, status: yield* settled(runId) }
    }))

    expect(observed.beforeDrain).toBe("suspended")
    expect(observed.status).toBe("completed")
  })

  it("leaves a run whose recorded signal names another wait point parked", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const state = yield* DurableEngineState.DurableEngineState
      const runId = yield* startControlRun
      yield* parkedRun(runId, "approval")
      yield* runtime.admitSignal("offline-shipped", runId, { name: "shipped", payload: null })

      yield* AgentSession.drainRecordedSignals
      const store = yield* RunStore.RunStore
      return { status: (yield* store.get(runId)).status, waiting: yield* state.waiting(runId) }
    }))

    expect(observed.status).toBe("suspended")
    expect(Option.isSome(observed.waiting)).toBe(true)
  })
})

/**
 * A durable state whose one run is parked exactly as the case describes.
 *
 * Both reads are stubbed: `deliverSignal` routes through `waitingTree` so a
 * wait held by a nested execution is reachable from the run an operator named,
 * and `waiting` is still what the observation ports read.
 */
const waitingAs = (reason: string, token: string | null) =>
  Layer.succeed(DurableEngineState.DurableEngineState)({
    ...DurableEngineState.makeMemory(),
    waiting: (runId: string) => Effect.succeedSome({ runId, reason, wakeAt: null, token }),
    waitingTree: (runId: string) => Effect.succeed([{ runId, reason, wakeAt: null, token }])
  } as DurableEngineState.Service)

describe("the ports when a store answers badly", () => {
  it("reports an engine that cannot record the cancellation as a typed failure", async () => {
    const failing = RunStore.layerNoop({
      requestCancelLineage: () =>
        Effect.fail(
          new RunStore.RunStoreError({
            method: "requestCancel",
            code: "persistence_failed",
            message: "the disk went away",
            cause: undefined
          })
        )
    })
    const failure = await Effect.runPromise(
      Effect.flip(AgentSession.requestCancel({ runId: "ports-store-down" })).pipe(Effect.provide(failing))
    )

    expect(failure).toBeInstanceOf(PersistenceError)
    expect((failure as PersistenceError).operation).toBe("AgentSession.requestCancel")
  })

  it("reports the store's atomic terminal answer when the run settles mid-request", async () => {
    // The store's atomic logical-run answer is authoritative. The port must
    // not map a terminal result to "recorded" and cancel a stale control row.
    const raced = RunStore.layerNoop({
      requestCancelLineage: () => Effect.succeed({ _tag: "Terminal", status: "cancelled" } as const)
    })

    const record = await Effect.runPromise(
      AgentSession.requestCancel({ runId: "ports-cancel-raced" }).pipe(Effect.provide(raced))
    )

    expect(record).toEqual({ _tag: "Terminal", status: "cancelled" })
  })

  it("refuses a signal to a park that names no wait point to complete", async () => {
    const observed = await Effect.runPromise(
      Effect.all([
        // An approval park with no token. The REASON no longer refuses a
        // signal — a human wait is answered through exactly this path — but a
        // park that recorded no wait address still names nothing to complete.
        AgentSession.deliverSignal({ runId: "ports-approval", signal: { name: "approval", payload: null } }).pipe(
          Effect.provide(Layer.merge(waitingAs("approval", null), FlowEngine.layerMemory))
        ),
        // An event park with no token: nothing names a wait point to complete.
        AgentSession.deliverSignal({ runId: "ports-tokenless", signal: { name: "approval", payload: null } }).pipe(
          Effect.provide(Layer.merge(waitingAs("event", null), FlowEngine.layerMemory))
        )
      ]).pipe(Effect.scoped)
    )

    expect(observed).toEqual(["no-match", "no-match"])
  })

  it("reports a corrupt wake token as a typed failure rather than parking forever", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        AgentSession.deliverSignal({ runId: "ports-corrupt", signal: { name: "approval", payload: null } })
      ).pipe(
        Effect.provide(Layer.merge(waitingAs("event", "not-a-durable-deferred-token"), FlowEngine.layerMemory)),
        Effect.scoped
      )
    )

    expect(failure).toBeInstanceOf(PersistenceError)
    expect((failure as PersistenceError).operation).toBe("AgentSession.deliverSignal")
  })
})

describe("durable signal admission and engine observation", () => {
  it("refuses durable delivery without the admitting control runtime before completing the wait", async () => {
    const token = new DurableDeferred.TokenParsed({
      flowName: Gated._tag,
      executionId: "missing-control-runtime",
      deferredName: "WaitFor/approval"
    }).asToken
    const state = DurableEngineState.makeMemory()
    const failure = await Effect.runPromise(
      AgentSession.deliverSignal({
        commandId: "durable-command",
        runId: "missing-control-runtime",
        token,
        signal: { name: "approval", payload: true }
      }).pipe(
        Effect.flip,
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provide(FlowEngine.layerMemory),
        Effect.scoped
      )
    )
    expect(failure).toBeInstanceOf(PersistenceError)
    expect(failure.message).toContain("requires ControlRuntime")
    expect(await Effect.runPromise(state.deferred(DurableDeferred.TokenParsed.fromString(token))))
      .toEqual(Option.none())
  })

  it("refuses a command whose wait token belongs to another admission without consuming the wait", async () => {
    await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const state = yield* DurableEngineState.DurableEngineState
      const runId = yield* startControlRun
      const waiting = yield* parkedRun(runId, "approval")
      if (waiting.token === null) return yield* Effect.die("missing token")
      yield* runtime.admitSignal("binding-winner", runId, { name: "approval", payload: "winner" })
      yield* runtime.admitSignal("binding-loser", runId, { name: "approval", payload: "loser" })
      yield* runtime.bindSignal("binding-winner", waiting.token)

      expect(yield* AgentSession.deliverSignal((yield* runtime.signalCommand("binding-loser"))!)).toBe("no-match")
      expect(yield* state.waiting(runId)).toEqual(Option.some(waiting))
      expect(yield* state.deferred(DurableDeferred.TokenParsed.fromString(waiting.token))).toEqual(Option.none())
      expect((yield* runtime.signalCommand("binding-loser"))?.token).toBeNull()
      expect(yield* AgentSession.deliverSignal((yield* runtime.signalCommand("binding-winner"))!)).toBe("delivered")
      expect(yield* settled(runId)).toBe("completed")
    }))
  })

  it("rejects a retry whose payload disagrees with the previously applied completion", async () => {
    await run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const waiting = yield* parkedRun("conflicting-retry", "approval")
      if (waiting.token === null) return yield* Effect.die("missing token")
      const command = {
        runId: "conflicting-retry",
        token: waiting.token,
        signal: { name: "approval", payload: { accepted: "original" } }
      }
      expect(yield* AgentSession.deliverSignal(command)).toBe("delivered")
      const before = yield* state.deferred(DurableDeferred.TokenParsed.fromString(waiting.token))
      expect(yield* AgentSession.deliverSignal({ ...command, signal: { name: "approval", payload: "changed" } }))
        .toBe("no-match")
      expect(yield* state.deferred(DurableDeferred.TokenParsed.fromString(waiting.token))).toEqual(before)
      expect(yield* AgentSession.deliverSignal(command)).toBe("delivered")
    }))
  })

  it("does not claim delivery when another resolver wins between the read and atomic completion", async () => {
    await run(Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      const state = yield* DurableEngineState.DurableEngineState
      const waiting = yield* parkedRun("competing-resolver", "approval")
      if (waiting.token === null) return yield* Effect.die("missing token")
      let races = 0
      const interleaved: FlowRuntime.FlowRuntime["Service"] = {
        ...runtime,
        deferredDoneIfWaiting: (deferred, options) =>
          Effect.gen(function*() {
            races++
            yield* runtime.deferredDoneIfWaiting(WaitFor.deferred("approval"), {
              ...options,
              exit: Exit.succeed("competing payload")
            })
            return yield* runtime.deferredDoneIfWaiting(deferred, options)
          })
      }
      expect(
        yield* AgentSession.deliverSignal({
          runId: "competing-resolver",
          token: waiting.token,
          signal: { name: "approval", payload: "our payload" }
        }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, interleaved))
      ).toBe("no-match")
      expect(races).toBe(1)
      const completed = yield* state.deferred(DurableDeferred.TokenParsed.fromString(waiting.token))
      if (Option.isNone(completed)) return yield* Effect.die("missing competing completion")
      expect(completed.value.exit).toEqual(Exit.succeed("competing payload"))
      expect(yield* settled("competing-resolver")).toBe("completed")
    }))
  })

  it("rejects a bound token when a competing wake removed the wait without completing it", async () => {
    await run(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const waiting = yield* parkedRun("competing-wake", "approval")
      if (waiting.token === null) return yield* Effect.die("missing token")
      yield* state.wake("competing-wake")
      expect(
        yield* AgentSession.deliverSignal({
          runId: "competing-wake",
          token: waiting.token,
          signal: { name: "approval", payload: "late" }
        })
      ).toBe("no-match")
      expect(yield* state.deferred(DurableDeferred.TokenParsed.fromString(waiting.token))).toEqual(Option.none())
    }))
  })

  it("keeps an admitted command pending until a completion is observable, even if the write port acknowledges", async () => {
    await run(Effect.gen(function*() {
      const control = yield* ControlRuntime
      const runtime = yield* FlowRuntime.FlowRuntime
      const state = yield* DurableEngineState.DurableEngineState
      const runId = yield* startControlRun
      const waiting = yield* parkedRun(runId, "approval")
      yield* control.admitSignal("unconfirmed-completion", runId, { name: "approval", payload: "confirm me" })
      let acknowledgments = 0
      yield* AgentSession.drainRecordedSignals.pipe(Effect.provideService(FlowRuntime.FlowRuntime, {
        ...runtime,
        // A remote/lagging adapter's acknowledgment is not durable read evidence.
        deferredDoneIfWaiting: () =>
          Effect.sync(() => {
            acknowledgments++
            return "Completed" as const
          })
      }))
      expect(acknowledgments).toBe(1)
      expect((yield* control.signalCommand("unconfirmed-completion"))?.state).toBe("pending")
      expect((yield* control.signalCommand("unconfirmed-completion"))?.token).toBe(waiting.token)
      expect(yield* state.waiting(runId)).toEqual(Option.some(waiting))
      yield* AgentSession.drainRecordedSignals
      expect((yield* control.signalCommand("unconfirmed-completion"))?.state).toBe("delivered")
    }))
  })

  it.each(["completed", "failed", "cancelled"] as const)(
    "settles an unbound command as terminal when the control run becomes %s",
    async (status) => {
      await run(Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const state = yield* DurableEngineState.DurableEngineState
        const runId = yield* startControlRun
        const waiting = yield* parkedRun(runId, "approval")
        yield* runtime.admitSignal("terminal-command", runId, { name: "approval", payload: "too late" })
        const fence = yield* runtime.claimFence(runId)
        yield* runtime.writeStatus(runId, fence, status)

        yield* AgentSession.drainRecordedSignals
        expect(yield* runtime.signalCommand("terminal-command")).toMatchObject({ state: "terminal", token: null })
        expect(yield* runtime.pendingSignals).toEqual([])
        expect(yield* state.waiting(runId)).toEqual(Option.some(waiting))
        yield* AgentSession.drainRecordedSignals
        expect((yield* runtime.getRun(runId)).status).toBe(status)
      }))
    }
  )

  it("retains a failed command for retry while delivering the next command in the same page", async () => {
    await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const first = yield* startControlRun
      const second = yield* startControlRun
      yield* parkedRun(first, "approval")
      yield* parkedRun(second, "approval")
      yield* runtime.admitSignal("transient-failure", first, { name: "approval", payload: "first" })
      yield* runtime.admitSignal("independent-command", second, { name: "approval", payload: "second" })
      let refusals = 0
      yield* AgentSession.drainRecordedSignals.pipe(Effect.provideService(ControlRuntime, {
        ...runtime,
        getRun: (runId) =>
          runId === first
            ? Effect.sync(() => {
              refusals++
            }).pipe(Effect.andThen(Effect.fail(
              new PersistenceError({
                operation: "getRun",
                message: "transient control read failure"
              })
            )))
            : runtime.getRun(runId)
      }))
      expect(refusals).toBe(1)
      expect((yield* runtime.signalCommand("transient-failure"))?.state).toBe("pending")
      expect((yield* runtime.signalCommand("independent-command"))?.state).toBe("delivered")
      expect(yield* statusOf(first)).toBe("suspended")
      yield* AgentSession.drainRecordedSignals
      expect((yield* runtime.signalCommand("transient-failure"))?.state).toBe("delivered")
      expect(yield* settled(first)).toBe("completed")
      expect(yield* settled(second)).toBe("completed")
      expect(yield* runtime.pendingSignals).toEqual([])
    }))
  })

  it("recovers lost acknowledgment using the original token with separate databases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smithers-signals-"))
    try {
      const controlLayer = SqlControlRuntime.layer({
        flows: [{ flowId: "system/test", description: "test", deployClass: false, envelope }]
      }).pipe(
        Layer.provide(fileBundle(join(directory, "control.db"))),
        Layer.provide(NodeCrypto.layer),
        Layer.orDie
      )
      const live = makeStack(controlLayer, join(directory, "engine.db"))
      const token = await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const runId = yield* startControlRun
          yield* runtime.admitSignal("lost-ack", runId, { name: "approval", payload: { approved: true } })
          yield* AgentSession.drainRecordedSignals
          expect((yield* runtime.signalCommand("lost-ack"))?.token).toBeNull()
          yield* parkedRun(runId, "approval")
          expect(yield* AgentSession.readExecution(runId)).toMatchObject({
            _tag: "Observed",
            status: "parked",
            waitingReason: "event"
          })
          expect((yield* runtime.getRun(runId)).waitingReason).toBeUndefined()
          const command = (yield* runtime.signalCommand("lost-ack"))!
          expect(yield* AgentSession.deliverSignal(command)).toBe("delivered")
          const bound = (yield* runtime.signalCommand("lost-ack"))!
          expect(bound.token).not.toBeNull()
          expect(bound.state).toBe("pending")
          // The engine applied, but the acknowledgment was lost. Retry the bound token.
          expect(yield* AgentSession.deliverSignal(bound)).toBe("delivered")
          yield* AgentSession.drainRecordedSignals
          expect((yield* runtime.signalCommand("lost-ack"))?.state).toBe("delivered")
          expect(yield* runtime.pendingSignals).toEqual([])
          return bound.token
        }).pipe(Effect.provide(live), Effect.scoped, Effect.orDie)
      )
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const persisted = yield* runtime.signalCommand("lost-ack")
          expect(persisted?.token).toBe(token)
          expect(persisted?.state).toBe("delivered")
        }).pipe(Effect.provide(controlLayer), Effect.scoped)
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("delivers early admission after a wait opens without restarting", async () => {
    await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* startControlRun
      yield* runtime.admitSignal("before-wait", runId, { name: "approval", payload: "early" })
      yield* AgentSession.drainRecordedSignals
      expect((yield* runtime.pendingSignals).length).toBe(1)
      yield* parkedRun(runId, "approval")
      yield* AgentSession.drainRecordedSignals
      expect((yield* runtime.signalCommand("before-wait"))?.state).toBe("delivered")
      expect(yield* settled(runId)).toBe("completed")
    }))
  })

  it("binds only one admitted command to a concrete wait", async () => {
    await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* startControlRun
      yield* parkedRun(runId, "approval")
      yield* runtime.admitSignal("winner", runId, { name: "approval", payload: 1 })
      yield* runtime.admitSignal("loser", runId, { name: "approval", payload: 2 })
      const state = yield* DurableEngineState.DurableEngineState
      const waiting = yield* state.waiting(runId)
      if (Option.isNone(waiting) || waiting.value.token === null) return yield* Effect.die("missing token")
      expect(yield* runtime.bindSignal("winner", waiting.value.token)).toBe(waiting.value.token)
      expect(yield* runtime.bindSignal("loser", waiting.value.token)).toBeNull()
      expect((yield* runtime.signalCommand("loser"))?.token).toBeNull()
    }))
  })
})
