import * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * The adapter pinned against the contracts the durable engine enforces, using
 * runtime doubles that decorate the real in-memory `FlowRuntime`.
 *
 * The release policy requires the durable engine to
 * refuse `FlowRuntime.interruptUnsafe` with `unsafe_interrupt_unsupported`, so
 * an adapter that cancels through it cannot run one interrupt pin against the
 * only durable engine that ships. Nothing in the repository caught that,
 * because the applied suite binds the memory layer, whose `interruptUnsafe`
 * works. These cases make the refusal explicit, and bound the publication
 * confirmation the adapter ends every run with.
 */
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as EngineSubject from "../../src/EngineSubject.ts"
import * as FlowEngineLike from "../../src/FlowEngineLike.ts"
import { EngineUnavailableError } from "../../src/TestingError.ts"
import { describe, expect, it } from "../../src/Vitest.ts"

/** Decorates the in-memory runtime, keeping every other operation real. */
type Runtime = FlowRuntime.FlowRuntime["Service"]

const decorated = (
  decorate: (runtime: Runtime) => Partial<Runtime>
): Layer.Layer<EngineSubject.EngineSubject> =>
  FlowEngineLike.layerOver(
    Layer.effect(FlowRuntime.FlowRuntime)(
      Effect.map(
        FlowRuntime.FlowRuntime,
        (runtime) => FlowRuntime.FlowRuntime.of({ ...runtime, ...decorate(runtime) })
      )
    ).pipe(Layer.provide(FlowEngine.layerMemory))
  )

const realSubject = FlowEngineLike.layerOver(FlowEngine.layerMemory)

const waiting: EngineSubject.FlowSpec = {
  name: "testing/engine-like/contract/waiting",
  steps: [{
    key: "waiting",
    sealed: false,
    kind: "step",
    run: () => Effect.never
  }]
}

const settling: EngineSubject.FlowSpec = {
  name: "testing/engine-like/contract/settling",
  steps: [{
    key: "settling",
    sealed: false,
    kind: "step",
    run: () => Effect.succeed("done")
  }]
}

const unsafeCalls = { count: 0 }

const countsUnsafe = decorated((real) => ({
  interruptUnsafe: (flow, executionId) =>
    Effect.suspend(() => {
      unsafeCalls.count += 1
      return real.interruptUnsafe(flow, executionId)
    })
}))

const refusesUnsafe = decorated(() => ({
  interruptUnsafe: (_flow, executionId) =>
    Effect.fail(
      new FlowRuntime.CancelRequestFailed({
        code: "unsafe_interrupt_unsupported",
        executionId,
        reason: "the durable engine has one cancellation path"
      })
    )
}))

const neverPublishes = decorated(() => ({ poll: () => Effect.succeed(Option.none()) }))

let polledResult: Flow.Result<unknown, unknown> = new Flow.Suspended()
const reportsScriptedResult = decorated(() => ({
  poll: ((_flow, _executionId) => Effect.succeed(Option.some(polledResult))) as Runtime["poll"]
}))

const missingPoll = new FlowRuntime.FlowExecutionNotFound({
  code: "execution_not_found",
  executionId: "testing/engine-like/contract/poll-failure"
})
const failsPollAndIgnoresInterrupt = decorated(() => ({
  poll: ((_flow, _executionId) => Effect.fail(missingPoll)) as Runtime["poll"],
  interrupt: ((_flow, _executionId) => Effect.void) as Runtime["interrupt"]
}))

let submissionError: unknown = new Error("submission refused")
const rejectsSubmission = decorated(() => ({
  execute: ((_flow, _options) => Effect.fail(submissionError)) as Runtime["execute"]
}))

// Refuses a bounded number of submissions before using the real runtime.
const refusesSubmissions = (count: number, error: unknown) =>
  decorated((real) => {
    let remaining = count
    return {
      execute: ((flow, options) =>
        Effect.suspend(() => {
          if (remaining === 0) return real.execute(flow, options)
          remaining -= 1
          return Effect.fail(error)
        })) as Runtime["execute"]
    }
  })

const cancelled = (executionId: string) =>
  Effect.gen(function*() {
    const engine = yield* EngineSubject.EngineSubject
    const running = yield* Effect.forkChild(
      engine.run({ flow: waiting, payload: undefined, executionId }),
      { startImmediately: true }
    )
    yield* Effect.yieldNow
    yield* engine.interrupt(executionId)
    yield* Fiber.await(running)
    return yield* engine.result(executionId)
  })

describe("FlowEngineLike honours the durable cancellation contract", () => {
  it.scoped("cancels through interrupt and never touches interruptUnsafe", () =>
    Effect.gen(function*() {
      const result = yield* cancelled("testing/engine-like/contract/cancel")
      expect(result.status).toBe("aborted")
      expect(unsafeCalls.count).toBe(0)
    }).pipe(Effect.provide(countsUnsafe)))

  it.scoped("still cancels when the runtime refuses interruptUnsafe the way the durable engine does", () =>
    Effect.gen(function*() {
      const result = yield* cancelled("testing/engine-like/contract/refused")
      expect(result.status).toBe("aborted")
    }).pipe(Effect.provide(refusesUnsafe)))
})

describe("FlowEngineLike bounds its publication confirmation", () => {
  it.scoped("fails typed instead of spinning when the runtime never publishes a result", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const error = yield* engine.run({
        flow: settling,
        payload: undefined,
        executionId: "testing/engine-like/contract/unpublished"
      }).pipe(Effect.flip)
      expect(error._tag).toBe("EngineUnavailableError")
      expect((error as { readonly message: string }).message).toContain("did not publish its result")
    }).pipe(Effect.provide(neverPublishes)))
})

describe("FlowEngineLike confirms cancellation of parked rounds", () => {
  for (const publication of ["delayed", "missing"] as const) {
    it.scoped(`${publication} cancellation publication is bounded`, () => {
      let cancelling = false
      let polls = 0
      const subject = decorated((real) => ({
        interrupt: (flow, executionId) => {
          cancelling = true
          return real.interrupt(flow, executionId)
        },
        poll: (flow, executionId) => {
          if (cancelling && (publication === "missing" || polls++ < 3)) {
            return Effect.succeed(Option.none())
          }
          return real.poll(flow, executionId)
        }
      }))
      return Effect.gen(function*() {
        const engine = yield* EngineSubject.EngineSubject
        const executionId = `testing/engine-like/contract/cancel-${publication}`
        expect(
          (yield* engine.run({
            flow: {
              name: executionId,
              steps: [{ key: "park", sealed: false, kind: "step", run: () => Effect.interrupt }]
            },
            payload: undefined,
            executionId
          })).status
        ).toBe("suspended")

        if (publication === "missing") {
          const error = yield* engine.interrupt(executionId).pipe(Effect.flip)
          expect(error).toMatchObject({ code: "engine_unavailable" })
          expect((error as EngineUnavailableError).message).toContain("did not publish its cancellation result")
        } else {
          yield* engine.interrupt(executionId)
          expect(yield* engine.resume(executionId)).toEqual({ executionId, status: "aborted" })
        }
      }).pipe(Effect.provide(subject))
    })
  }
})

describe("FlowEngineLike projects every runtime result", () => {
  it.scoped("reports a known live execution as suspended when poll has no result", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const started = yield* Latch.make()
      const executionId = "testing/engine-like/contract/live-result"
      const running = yield* engine.run({
        flow: {
          name: "testing/engine-like/contract/live-result",
          steps: [{
            key: "waiting",
            sealed: false,
            kind: "step",
            run: () => Effect.andThen(started.open, Effect.never)
          }]
        },
        payload: undefined,
        executionId
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* started.await

      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "suspended" })
      yield* engine.interrupt(executionId)
      expect((yield* Fiber.join(running)).status).toBe("aborted")
    }).pipe(Effect.provide(realSubject)))

  it.scoped("distinguishes suspension, success, handoff, failure, and interruption", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const started = yield* Latch.make()
      const executionId = "testing/engine-like/contract/result-projection"
      const running = yield* engine.run({
        flow: {
          name: "testing/engine-like/contract/result-projection",
          steps: [{
            key: "waiting",
            sealed: false,
            kind: "step",
            run: () => Effect.andThen(started.open, Effect.never)
          }]
        },
        payload: undefined,
        executionId
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* started.await

      polledResult = new Flow.Suspended()
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "suspended" })

      polledResult = new Flow.Complete({ exit: Exit.succeed(undefined) })
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "completed" })

      polledResult = new Flow.Complete({ exit: Exit.succeed("published") })
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "completed", value: "published" })

      polledResult = new Flow.Handoff({ flow: "next-round", payload: { cursor: 2 } })
      const handoff = yield* engine.result(executionId)
      expect(handoff.status).toBe("failed")
      expect(handoff.value).toMatchObject({ code: "engine_unavailable" })
      expect((handoff.value as EngineUnavailableError).message).toContain("handed off to flow next-round")

      const refused = new EngineUnavailableError({ message: "runtime refusal" })
      polledResult = new Flow.Complete({ exit: Exit.fail(refused) })
      expect(yield* engine.result(executionId)).toMatchObject({
        executionId,
        status: "failed",
        value: { code: "engine_unavailable", message: "runtime refusal" }
      })

      polledResult = new Flow.Complete({ exit: Exit.failCause(Cause.interrupt()) })
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })

      yield* engine.interrupt(executionId)
      expect((yield* Fiber.join(running)).status).toBe("aborted")
    }).pipe(Effect.provide(reportsScriptedResult)))

  it.scoped("reports poll failure until an explicit interrupt marks the execution aborted", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const started = yield* Latch.make()
      const executionId = "testing/engine-like/contract/poll-failure"
      yield* engine.run({
        flow: {
          name: "testing/engine-like/contract/poll-failure",
          steps: [{
            key: "waiting",
            sealed: false,
            kind: "step",
            run: () => Effect.andThen(started.open, Effect.never)
          }]
        },
        payload: undefined,
        executionId
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* started.await

      const error = yield* engine.result(executionId).pipe(Effect.flip)
      expect(error).toMatchObject({ code: "engine_unavailable" })
      expect((error as EngineUnavailableError).message).toContain("failed while polling")

      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
    }).pipe(Effect.provide(failsPollAndIgnoresInterrupt)))
})

describe("FlowEngineLike preserves typed submission failures", () => {
  it.scoped("maps foreign failures and passes FlowCycleDetected through", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject

      submissionError = new Error("submission refused")
      const unavailable = yield* engine.run({
        flow: { ...settling, name: "testing/engine-like/contract/submission-refused" },
        payload: undefined,
        executionId: "testing/engine-like/contract/submission-refused"
      }).pipe(Effect.flip)
      expect(unavailable).toMatchObject({ code: "engine_unavailable" })
      expect((unavailable as EngineUnavailableError).message).toContain("submission refused")

      submissionError = new FlowRuntime.FlowCycleDetected({ path: ["parent", "child", "parent"] })
      const cycle = yield* engine.run({
        flow: { ...settling, name: "testing/engine-like/contract/submission-cycle" },
        payload: undefined,
        executionId: "testing/engine-like/contract/submission-cycle"
      }).pipe(Effect.flip)
      expect(cycle).toMatchObject({
        code: "flow_cycle_detected",
        path: ["parent", "child", "parent"]
      })
    }).pipe(Effect.provide(rejectsSubmission)))
})

describe("FlowEngineLike forgets a refused submission", () => {
  const flow = { ...settling, name: "testing/engine-like/contract/resubmitted" }

  for (
    const failure of [
      { error: new Error("submission refused"), code: "engine_unavailable" },
      {
        error: new FlowRuntime.FlowCycleDetected({ path: ["parent", "child", "parent"] }),
        code: "flow_cycle_detected"
      }
    ]
  ) {
    for (const identity of ["executionId", "idempotencyKey"] as const) {
      it.scoped(`submits again under the same ${identity} after ${failure.code}`, () =>
        Effect.gen(function*() {
          const engine = yield* EngineSubject.EngineSubject
          const id = `resubmitted-${identity}-${failure.code}`
          const options = { flow, payload: undefined, [identity]: id }

          for (const _ of [1, 2]) {
            const refused = yield* engine.run(options).pipe(Effect.flip)
            expect(refused).toMatchObject({ code: failure.code })
            if (failure.error instanceof FlowRuntime.FlowCycleDetected) expect(refused).toBe(failure.error)
            if (identity === "executionId") {
              // The engine never accepted the execution, so there is nothing to report.
              expect(yield* engine.result(id).pipe(Effect.flip))
                .toMatchObject({ code: "engine_unavailable" })
            }
          }

          const completed = yield* engine.run(options)
          expect(completed).toMatchObject({ status: "completed", value: "done" })
          expect(yield* engine.result(completed.executionId)).toEqual(completed)
          expect(yield* engine.run(options)).toEqual(completed)
        }).pipe(Effect.provide(refusesSubmissions(2, failure.error))))

      it.scoped(`wakes concurrent ${identity} joiners after ${failure.code}`, () =>
        Effect.gen(function*() {
          const entered = yield* Latch.make()
          const release = yield* Latch.make()
          const id = `concurrent-${identity}-${failure.code}`
          const retainedId = `${id}-retained`
          let submissions = 0
          const runtime = decorated((real) => ({
            execute: ((flow, options) =>
              Effect.suspend(() => {
                if (options.executionId === retainedId) return real.execute(flow, options)
                submissions += 1
                return submissions === 1
                  ? Effect.andThen(entered.open, Effect.andThen(release.await, Effect.fail<unknown>(failure.error)))
                  : real.execute(flow, options)
              })) as Runtime["execute"]
          }))
          yield* Effect.gen(function*() {
            const engine = yield* EngineSubject.EngineSubject
            const options = {
              flow,
              payload: undefined,
              executionId: id,
              ...(identity === "idempotencyKey" ? { idempotencyKey: `${id}-key` } : {})
            }
            const retainedOptions = { flow, payload: undefined, executionId: retainedId, idempotencyKey: retainedId }
            const retained = yield* engine.run(retainedOptions)
            const first = yield* engine.run(options).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
            yield* entered.await
            const joiner = yield* engine.run({
              ...options,
              executionId: identity === "idempotencyKey" ? `${id}-ignored` : id
            }).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
            const alias = `${id}-alias`
            const aliasJoiner = yield* engine.run({ ...options, idempotencyKey: alias })
              .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
            expect(submissions).toBe(1)
            yield* release.open
            for (const fiber of [first, joiner, aliasJoiner]) {
              const exit = yield* Fiber.join(fiber)
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) {
                const error = Cause.squash(exit.cause)
                expect(error).toMatchObject({ code: failure.code })
                if (failure.error instanceof FlowRuntime.FlowCycleDetected) expect(error).toBe(failure.error)
              }
            }
            expect(yield* engine.result(id).pipe(Effect.flip)).toMatchObject({ code: "engine_unavailable" })
            expect(yield* engine.run(options)).toMatchObject({ status: "completed", value: "done" })
            expect(submissions).toBe(2)
            // The refused attempt releases aliases added by concurrent callers,
            // while claims belonging to other executions remain idempotent.
            expect(yield* engine.run({ flow, payload: "different", idempotencyKey: alias }))
              .toMatchObject({ status: "completed", value: "done" })
            expect(yield* engine.run(retainedOptions)).toEqual(retained)
          }).pipe(Effect.provide(runtime))
        }))
    }
  }
})

describe("FlowEngineLike Web Crypto", () => {
  it.scoped("provides fresh random byte arrays of the requested length", () =>
    Effect.gen(function*() {
      const crypto = yield* SecureRandom.SecureRandom
      const first = yield* crypto.randomBytes(16)
      const second = yield* crypto.randomBytes(7)

      expect(first).toBeInstanceOf(Uint8Array)
      expect(first).toHaveLength(16)
      expect(second).toHaveLength(7)
      expect(second).not.toBe(first)
    }).pipe(Effect.provide(FlowEngineLike.layerMemory)))
})
