// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Fiber, Latch, Layer, Option, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { effect, isComplete, pollUntil } from "./Harness.ts"
import { layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const Gate = DurableDeferred.make("DurableDeferred/Gate", {
  success: Schema.String,
  error: Schema.String
})

/** One declared step, and the flow made of it, for a case's durable body. */
const makeFlow = (
  tag: string,
  body: Effect.Effect<
    string,
    string,
    FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Scope.Scope
  >
) => {
  const step = Action.make(`${tag}/step`, {
    payload: { id: Schema.String },
    success: Schema.String,
    error: Schema.String
  })
  const flow = Flow.make(tag, {
    payload: { id: Schema.String },
    success: Schema.String,
    error: Schema.String,
    idempotencyKey: ({ id }) => id,
    body: (payload) => step.call(payload)
  })
  return {
    flow,
    layer: layerWired(Layer.mergeAll(step.toLayer(() => body), Interpreter.layer(flow)))
  }
}

const completeToken = <S extends Schema.Constraint, E extends Schema.Constraint>(
  deferred: DurableDeferred.DurableDeferred<S, E>,
  flow: Flow.Any,
  executionId: string
) => Effect.sync(() => DurableDeferred.tokenFromExecutionId(deferred, { flow, executionId }))

describe("DurableDeferred", () => {
  effect("tokens round-trip through their base64url encoding", () =>
    Effect.sync(() => {
      const token = new DurableDeferred.TokenParsed({
        flowName: "Some/Flow",
        executionId: "exec-1",
        deferredName: "Gate"
      }).asToken
      const parsed = DurableDeferred.TokenParsed.fromString(token)
      expect(parsed.flowName).toBe("Some/Flow")
      expect(parsed.executionId).toBe("exec-1")
      expect(parsed.deferredName).toBe("Gate")
      expect(DurableDeferred.TokenParsed.encode(parsed)).toBe(token)
    }))

  effect("the public parser returns a typed failure for untrusted strings", () =>
    Effect.gen(function*() {
      const token = new DurableDeferred.TokenParsed({
        flowName: "Some/Flow",
        executionId: "exec-1",
        deferredName: "Gate"
      }).asToken
      expect(yield* DurableDeferred.TokenParsed.parse(token)).toMatchObject({
        flowName: "Some/Flow",
        executionId: "exec-1",
        deferredName: "Gate"
      })
      const failure = yield* DurableDeferred.TokenParsed.parse("not-a-token").pipe(Effect.flip)
      expect(failure).toBeInstanceOf(DurableDeferred.TokenInvalid)
    }))

  effect("freezes the token wire format as base64url of a three-string tuple", () =>
    Effect.sync(() => {
      // External approvers, persisted waiting rows, and `HumanTask.answer` all
      // hold this string across versions, so the encoding and the tuple order
      // are pinned by literal rather than by round-trip. A change to either is
      // a red test instead of a silent wire break.
      const golden = "WyJTb21lL0Zsb3ciLCJleGVjLTEiLCJHYXRlIl0"
      expect(
        new DurableDeferred.TokenParsed({
          flowName: "Some/Flow",
          executionId: "exec-1",
          deferredName: "Gate"
        }).asToken
      ).toBe(golden)

      const parsed = DurableDeferred.TokenParsed.fromString(golden as DurableDeferred.Token)
      expect([parsed.flowName, parsed.executionId, parsed.deferredName]).toEqual([
        "Some/Flow",
        "exec-1",
        "Gate"
      ])
    }))

  effect("malformed completion tokens preserve the parse issue and a bounded excerpt", () =>
    Effect.gen(function*() {
      const malformed = "*".repeat(100) as DurableDeferred.Token
      const failure = yield* DurableDeferred.done(Gate, {
        token: malformed,
        exit: Exit.succeed("ignored")
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DurableDeferred.TokenInvalid)
      expect(failure.code).toBe("malformed_token")
      expect(failure.message).toContain("Base64Url")
      expect(failure.message).toContain("*".repeat(64))
      expect(failure.message).toContain("36 characters dropped")
      expect(failure.message).not.toContain(malformed)
    }).pipe(Effect.provide(layerWired(Layer.empty))))

  effect("completion tokens are bound to the deferred they name", () => {
    const A = DurableDeferred.make("DurableDeferred/Bound/A", {
      success: Schema.String,
      error: Schema.String
    })
    const B = DurableDeferred.make("DurableDeferred/Bound/B", {
      success: Schema.String,
      error: Schema.String
    })
    const token = new DurableDeferred.TokenParsed({
      flowName: "DurableDeferred/Bound/Flow",
      executionId: "bound",
      deferredName: A.name
    }).asToken
    const mismatch = <R>(effect: Effect.Effect<void, DurableDeferred.TokenInvalid, R>) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(effect)
        expect(failure).toBeInstanceOf(DurableDeferred.TokenInvalid)
        expect(failure.code).toBe("deferred_mismatch")
        expect(failure.message).toContain(A.name)
        expect(failure.message).toContain(B.name)
      })

    return Effect.gen(function*() {
      yield* mismatch(DurableDeferred.done(B, { token, exit: Exit.succeed("done") }))
      // succeed, fail, and failCause delegate to done, so each inherits the
      // same deferred-name binding.
      yield* mismatch(DurableDeferred.succeed(B, { token, value: "done" }))
      yield* mismatch(DurableDeferred.fail(B, { token, error: "failed" }))
      yield* mismatch(DurableDeferred.failCause(B, { token, cause: Cause.fail("caused") }))
    }).pipe(Effect.provide(layerWired(Layer.empty)))
  })

  effect("deferred mismatch diagnostics bound the token's deferred name", () =>
    Effect.gen(function*() {
      const deferredName = "x".repeat(1024 * 1024)
      const token = new DurableDeferred.TokenParsed({
        flowName: "DurableDeferred/Bound/Flow",
        executionId: "bound",
        deferredName
      }).asToken
      const failure = yield* DurableDeferred.done(Gate, {
        token,
        exit: Exit.succeed("ignored")
      }).pipe(Effect.flip)

      expect(failure.code).toBe("deferred_mismatch")
      expect(failure.message).toContain(Gate.name)
      expect(failure.message).toContain(`${deferredName.length - 64} characters dropped`)
      expect(failure.message.length).toBeLessThan(256)
    }).pipe(Effect.provide(layerWired(Layer.empty))))

  effect("tokenFromPayload derives the same token as the running instance", () => {
    const flow = Flow.make("DurableDeferred/token-payload", {
      payload: { id: Schema.String },
      success: Schema.Void,
      idempotencyKey: ({ id }) => id,
      body: () => Node.succeed(undefined)
    })
    return Effect.gen(function*() {
      const executionId = yield* flow.executionId({ id: "abc" })
      const fromPayload = yield* DurableDeferred.tokenFromPayload(Gate, {
        flow,
        payload: { id: "abc" }
      })
      const fromInstance = yield* DurableDeferred.token(Gate).pipe(
        Effect.provideService(
          FlowRuntime.FlowInstance,
          makeInstance(flow, executionId)
        )
      )
      expect(fromPayload).toBe(fromInstance)
      expect(DurableDeferred.TokenParsed.fromString(fromPayload).deferredName).toBe(Gate.name)
    })
  })

  effect("tokenFromPayload mints a fresh execution id for a flow without idempotencyKey", () => {
    const flow = Flow.make("DurableDeferred/token-payload-unkeyed", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    return Effect.gen(function*() {
      const first = yield* DurableDeferred.tokenFromPayload(Gate, { flow, payload: { id: "abc" } })
      const second = yield* DurableDeferred.tokenFromPayload(Gate, { flow, payload: { id: "abc" } })
      // The same payload addresses a new execution on every call, so a
      // resolver must keep the original execution id.
      expect(DurableDeferred.TokenParsed.fromString(first).executionId).not.toBe(
        DurableDeferred.TokenParsed.fromString(second).executionId
      )
    })
  })

  effect("awaiting an unresolved deferred suspends the flow until it succeeds", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-success",
      Effect.map(DurableDeferred.await(Gate), (value) => `got:${value}`)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "s" }, { discard: true })
      yield* Effect.yieldNow
      const suspended = yield* flow.poll(executionId)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.succeed(Gate, { token, value: "hello" })

      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("got:hello")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a deferred failure propagates as a typed flow failure", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-fail",
      DurableDeferred.await(Gate)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "f" }, { discard: true })
      yield* Effect.yieldNow
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.fail(Gate, { token, error: "boom" })

      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a deferred failure can be handled inside the flow", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-handled",
      DurableDeferred.await(Gate).pipe(
        Effect.catch((error) => Effect.succeed(`recovered:${error}`))
      )
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "h" }, { discard: true })
      yield* Effect.yieldNow
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.fail(Gate, { token, error: "boom" })

      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("recovered:boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a deferred defect propagates as a die cause", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-defect",
      DurableDeferred.await(Gate)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "d" }, { discard: true })
      yield* Effect.yieldNow
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.failCause(Gate, {
        token,
        cause: Cause.die("defective")
      })

      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a recorded interruption is a terminal outcome, not a request to suspend", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-interrupt",
      DurableDeferred.await(Gate)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "int" }, { discard: true })
      yield* Effect.yieldNow
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.failCause(Gate, { token, cause: Cause.interrupt(1) })

      // an interrupt-only cause must terminate the run; if it were mistaken for
      // an external suspension interrupt the run would spin in suspended-retry
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag).toBe("Complete")
      if (Option.isSome(result) && result.value._tag === "Complete") {
        expect(Exit.isFailure(result.value.exit)).toBe(true)
        if (Exit.isFailure(result.value.exit)) {
          expect(Cause.hasInterruptsOnly(result.value.exit.cause)).toBe(true)
        }
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a recorded interruption reached through raceAll is a terminal outcome", () => {
    const Raced = DurableDeferred.make("DurableDeferred/RacedInterrupt", {
      success: Schema.String,
      error: Schema.String
    })
    const { flow, layer } = makeFlow(
      "DurableDeferred/raced-interrupt",
      DurableDeferred.raceAll({
        name: "recorded-interrupt",
        success: Schema.String,
        error: Schema.String,
        effects: [DurableDeferred.await(Raced)]
      })
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "raced-int" }, { discard: true })
      yield* Effect.yieldNow
      const token = yield* completeToken(Raced, flow, executionId)
      yield* DurableDeferred.failCause(Raced, { token, cause: Cause.interrupt(2) })

      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag).toBe("Complete")
      if (Option.isSome(result) && result.value._tag === "Complete") {
        expect(Exit.isFailure(result.value.exit)).toBe(true)
        if (Exit.isFailure(result.value.exit)) {
          expect(Cause.hasInterruptsOnly(result.value.exit.cause)).toBe(true)
        }
      }
    }).pipe(Effect.provide(layer))
  })

  effect("into drops interrupt reasons from a mixed cause and records the failure", () => {
    const Mixed = DurableDeferred.make("DurableDeferred/Mixed", {
      success: Schema.Number,
      error: Schema.String
    })
    const Step = Action.make("DurableDeferred/into-mixed/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableDeferred/into-mixed", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const mixedCause = Cause.fromReasons<string>([
      ...Cause.fail("boom").reasons,
      ...Cause.interrupt(7).reasons
    ])
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* DurableDeferred.into(
            Effect.failCause(mixedCause) as Effect.Effect<number, string>,
            Mixed
          ).pipe(Effect.exit)
          const persisted = yield* engine.deferredResult(Mixed)
          expect(Option.isSome(persisted)).toBe(true)
          if (Option.isNone(persisted)) return "missing"
          const exit = persisted.value as Exit.Exit<number, string>
          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) return "not-a-failure"
          // the interrupt reason is stripped; only the typed failure is durable
          expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(false)
          return String(exit.cause.reasons.find(Cause.isFailReason)?.error)
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "mixed" })).toBe("boom")
    }).pipe(Effect.provide(layer))
  })

  effect("an interrupted into that never suspended records nothing durable", () => {
    const Guarded = DurableDeferred.make("DurableDeferred/Guarded", {
      success: Schema.Number,
      error: Schema.String
    })
    const Step = Action.make("DurableDeferred/interrupted-into/step", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("DurableDeferred/interrupted-into", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          // Interrupt an awaiter mid-`into` without a suspension: the wrapped
          // effect dies with an interrupt-only cause while `suspended` stays
          // false. This is a driver interruption, not a durable outcome.
          const entered = yield* Latch.make()
          const awaiter = yield* Effect.forkChild(DurableDeferred.into(
            entered.open.pipe(Effect.andThen(Effect.never)),
            Guarded
          ))
          yield* entered.await
          yield* Fiber.interrupt(awaiter)
          // The interrupted awaiter must not have recorded anything durable —
          // an empty-cause failure here would win first-writer-wins and
          // permanently poison every replay of this deferred.
          expect(Option.isNone(yield* engine.deferredResult(Guarded))).toBe(true)
          // The real completion still lands...
          const token = yield* DurableDeferred.token(Guarded)
          yield* DurableDeferred.succeed(Guarded, { token, value: 42 }).pipe(Effect.orDie)
          // ...and the replay read returns it, not `Error: Empty cause`.
          return yield* DurableDeferred.await(Guarded)
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "int" })).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  effect("the first completion wins and later completions are ignored", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/first-wins",
      Effect.map(DurableDeferred.await(Gate), (value) => `got:${value}`)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "w" }, { discard: true })
      yield* Effect.yieldNow
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.succeed(Gate, { token, value: "first" })
      // a divergent duplicate completion must not overwrite the winner
      yield* DurableDeferred.succeed(Gate, { token, value: "second" })
      yield* DurableDeferred.fail(Gate, { token, error: "late-failure" })

      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("got:first")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("simultaneous success and failure completion persist exactly one replayable winner", () => {
    const Contended = DurableDeferred.make("DurableDeferred/Contended", {
      success: Schema.String,
      error: Schema.String
    })
    const { flow, layer } = makeFlow(
      "DurableDeferred/contended",
      DurableDeferred.await(Contended)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "contended" }, { discard: true })
      const suspended = yield* pollUntil(flow.poll(executionId), () => true, { turns: 20 })
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      const token = yield* completeToken(Contended, flow, executionId)
      const release = yield* Latch.make()
      const success = yield* Effect.forkChild(
        release.await.pipe(
          Effect.andThen(DurableDeferred.succeed(Contended, { token, value: "won" }))
        )
      )
      const failure = yield* Effect.forkChild(
        release.await.pipe(
          Effect.andThen(DurableDeferred.fail(Contended, { token, error: "lost" }))
        )
      )
      yield* release.open
      yield* Fiber.join(success)
      yield* Fiber.join(failure)

      const settled = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(settled) && settled.value._tag).toBe("Complete")
      if (Option.isNone(settled) || settled.value._tag !== "Complete") return
      const first = JSON.stringify(settled.value.exit)

      yield* DurableDeferred.succeed(Contended, { token, value: "late-success" })
      yield* DurableDeferred.fail(Contended, { token, error: "late-failure" })
      const replayed = yield* flow.poll(executionId)
      expect(Option.isSome(replayed) && replayed.value._tag).toBe("Complete")
      if (Option.isSome(replayed) && replayed.value._tag === "Complete") {
        expect(JSON.stringify(replayed.value.exit)).toBe(first)
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a completion recorded before the flow awaits is redelivered", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/early-completion",
      Effect.map(DurableDeferred.await(Gate), (value) => `got:${value}`)
    )
    return Effect.gen(function*() {
      // complete the deferred before the execution ever starts
      const executionId = yield* flow.executionId({ id: "e" })
      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow, executionId })
      yield* DurableDeferred.succeed(Gate, { token, value: "early" })

      const value = yield* flow.execute({ id: "e" })
      expect(value).toBe("got:early")
    }).pipe(Effect.provide(layer))
  })

  effect("into records the effect exit so a replay reuses it without re-running", () => {
    let runs = 0
    const Recorded = DurableDeferred.make("DurableDeferred/Recorded", {
      success: Schema.Number,
      error: Schema.String
    })
    const Step = Action.make("DurableDeferred/into/step", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("DurableDeferred/into", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const first = yield* DurableDeferred.into(
            Effect.sync(() => ++runs),
            Recorded
          )
          const persisted = yield* engine.deferredResult(Recorded)
          expect(Option.isSome(persisted)).toBe(true)
          const second = yield* DurableDeferred.into(
            Effect.sync(() => ++runs),
            Recorded
          )
          return first + second
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      // `into` writes the exit once; the recorded exit is what a resumed flow reads
      expect(yield* flow.execute({ id: "i" })).toBe(3)
      expect(runs).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll returns the first result and replays it from the persisted exit", () => {
    let attempts = 0
    const Step = Action.make("DurableDeferred/raceAll/step", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("DurableDeferred/raceAll", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const race = DurableDeferred.raceAll({
      name: "race",
      success: Schema.String,
      error: Schema.String,
      effects: [
        Effect.sync(() => {
          attempts++
          return "fast"
        }),
        Effect.never as Effect.Effect<string, string>
      ]
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* race
          const second = yield* race
          return `${first}/${second}`
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "r" })).toBe("fast/fast")
      // the second call reads the persisted race exit instead of racing again
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll persists and replays the terminal cause when every branch fails", () => {
    let attempts = 0
    const Step = Action.make("DurableDeferred/race-failure/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableDeferred/race-failure", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => Step.call(payload)
    })
    const race = DurableDeferred.raceAll({
      name: "all-fail",
      success: Schema.Never,
      error: Schema.String,
      effects: [
        Effect.sync(() => attempts++).pipe(Effect.andThen(Effect.fail("left"))),
        Effect.sync(() => attempts++).pipe(Effect.andThen(Effect.fail("right")))
      ]
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* Effect.exit(race)
          const replayed = yield* Effect.exit(race)
          expect(Exit.isFailure(first)).toBe(true)
          expect(replayed).toEqual(first)
          return "recorded"
        })
      ),
      Interpreter.layer(flow)
    ))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "all-fail" }, { executionId: "all-fail" })).toBe("recorded")
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll persists and replays the terminal cause when every branch defects", () => {
    let attempts = 0
    const Step = Action.make("DurableDeferred/race-defect/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableDeferred/race-defect", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => Step.call(payload)
    })
    const race = DurableDeferred.raceAll({
      name: "all-defect",
      success: Schema.Never,
      error: Schema.Never,
      effects: [
        Effect.sync(() => attempts++).pipe(Effect.andThen(Effect.die("left defect"))),
        Effect.sync(() => attempts++).pipe(Effect.andThen(Effect.die("right defect")))
      ]
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* Effect.exit(race)
          const replayed = yield* Effect.exit(race)
          expect(Exit.isFailure(first)).toBe(true)
          if (Exit.isFailure(first)) expect(first.cause.reasons.some(Cause.isDieReason)).toBe(true)
          expect(replayed).toEqual(first)
          return "recorded"
        })
      ),
      Interpreter.layer(flow)
    ))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "all-defect" }, { executionId: "all-defect" })).toBe("recorded")
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll over durable waits settles on the one branch that resolves", () => {
    const Fast = DurableDeferred.make("DurableDeferred/Race/Fast", { success: Schema.String })
    const Slow = DurableDeferred.make("DurableDeferred/Race/Slow", { success: Schema.String })
    const Step = Action.make("DurableDeferred/race-partial/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableDeferred/race-partial", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        DurableDeferred.raceAll({
          name: "either",
          success: Schema.String,
          error: Schema.Never,
          effects: [DurableDeferred.await(Fast), DurableDeferred.await(Slow)]
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "rp" }, { discard: true })
      yield* Effect.yieldNow
      // neither branch has a result yet, so the race itself is suspended
      const suspended = yield* pollUntil(flow.poll(executionId), () => true, { turns: 20 })
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      const tokenSlow = DurableDeferred.tokenFromExecutionId(Slow, { flow, executionId })
      yield* DurableDeferred.succeed(Slow, { token: tokenSlow, value: "slow" })
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("slow")
      }

      // a late completion of the losing branch cannot change the settled race
      const tokenFast = DurableDeferred.tokenFromExecutionId(Fast, { flow, executionId })
      yield* DurableDeferred.succeed(Fast, { token: tokenFast, value: "fast" })
      yield* Effect.yieldNow
      const settled = yield* flow.poll(executionId)
      expect(
        Option.isSome(settled) && settled.value._tag === "Complete" && Exit.isSuccess(settled.value.exit) &&
          settled.value.exit.value
      ).toBe("slow")
    }).pipe(Effect.provide(layer))
  })

  effect("withActionAttempt scopes the deferred name to the current attempt", () =>
    Effect.gen(function*() {
      const scoped = yield* Gate.withActionAttempt
      expect(scoped.name).toBe(`${Gate.name}/1`)
      const retryScoped = yield* Gate.withActionAttempt.pipe(
        Effect.provideService(Action.CurrentAttempt, 3)
      )
      expect(retryScoped.name).toBe(`${Gate.name}/3`)
    }))

  effect("concurrently awaited deferreds resume only once every branch has a result", () => {
    const A = DurableDeferred.make("DurableDeferred/Concurrent/A", { success: Schema.String })
    const B = DurableDeferred.make("DurableDeferred/Concurrent/B", { success: Schema.String })
    let bodies = 0
    const Step = Action.make("DurableDeferred/concurrent/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableDeferred/concurrent", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          bodies++
          const [a, b] = yield* Effect.all(
            [DurableDeferred.await(A), DurableDeferred.await(B)],
            { concurrency: "unbounded" }
          )
          return `${a}+${b}`
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "c" }, { discard: true })
      yield* Effect.yieldNow
      expect(Option.isSome(yield* flow.poll(executionId))).toBe(true)

      // resolving one branch of the concurrent pair is a *partial* frontier:
      // the flow re-runs, records A's result, and suspends again on B
      const tokenA = DurableDeferred.tokenFromExecutionId(A, { flow, executionId })
      yield* DurableDeferred.succeed(A, { token: tokenA, value: "a" })
      const partial = yield* pollUntil(flow.poll(executionId), () => true, { turns: 20 })
      expect(Option.isSome(partial) && partial.value._tag).toBe("Suspended")

      const tokenB = DurableDeferred.tokenFromExecutionId(B, { flow, executionId })
      yield* DurableDeferred.succeed(B, { token: tokenB, value: "b" })
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("a+b")
      }
      // one body run per resolution plus the initial attempt: resumption is
      // bounded by how many times the frontier advanced, not by branch count
      expect(bodies).toBe(3)
    }).pipe(Effect.provide(layer))
  })

  effect("precompleted concurrent deferreds finish in one replay without an intermediate suspension", () => {
    // Bazel Skyframe parity: `StateMachineTest.java`
    // parallelSubmachines_shorteningBothPathsReducesRestarts — when every
    // concurrent dependency already has a value, evaluation completes in a
    // single pass instead of suspending once per branch.
    const A = DurableDeferred.make("DurableDeferred/Precompleted/A", { success: Schema.String })
    const B = DurableDeferred.make("DurableDeferred/Precompleted/B", { success: Schema.String })
    let bodies = 0
    const Step = Action.make("DurableDeferred/precompleted/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableDeferred/precompleted", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          bodies++
          const [a, b] = yield* Effect.all(
            [DurableDeferred.await(A), DurableDeferred.await(B)],
            { concurrency: "unbounded" }
          )
          return `${a}+${b}`
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.executionId({ id: "pre" })
      // Both branches are completed before the flow ever runs.
      const tokenA = DurableDeferred.tokenFromExecutionId(A, { flow, executionId })
      const tokenB = DurableDeferred.tokenFromExecutionId(B, { flow, executionId })
      yield* DurableDeferred.succeed(A, { token: tokenA, value: "a" })
      yield* DurableDeferred.succeed(B, { token: tokenB, value: "b" })

      const startedId = yield* flow.execute({ id: "pre" }, { discard: true })
      expect(startedId).toBe(executionId)
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("a+b")
      }
      // The single replay reads both recorded results: exactly one body run,
      // no intermediate suspension.
      expect(bodies).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("independent deferreds resume the flow as each one resolves", () => {
    const A = DurableDeferred.make("DurableDeferred/Parallel/A", { success: Schema.String })
    const B = DurableDeferred.make("DurableDeferred/Parallel/B", { success: Schema.String })
    const Step = Action.make("DurableDeferred/parallel/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableDeferred/parallel", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          const a = yield* DurableDeferred.await(A)
          const b = yield* DurableDeferred.await(B)
          return `${a}+${b}`
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "p" }, { discard: true })
      yield* Effect.yieldNow
      const tokenB = DurableDeferred.tokenFromExecutionId(B, { flow, executionId })
      // resolving the not-yet-awaited deferred first must not complete the flow
      yield* DurableDeferred.succeed(B, { token: tokenB, value: "b" })
      const stillSuspended = yield* pollUntil(flow.poll(executionId), () => true, { turns: 20 })
      expect(Option.isSome(stillSuspended) && stillSuspended.value._tag).toBe("Suspended")

      const tokenA = DurableDeferred.tokenFromExecutionId(A, { flow, executionId })
      yield* DurableDeferred.succeed(A, { token: tokenA, value: "a" })
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("a+b")
      }
    }).pipe(Effect.provide(layer))
  })
})
