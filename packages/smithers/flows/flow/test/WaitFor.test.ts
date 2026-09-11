/**
 * The system wait action: what it puts in a plan, how it parks, how the
 * ordinary deferred completion path resumes it, and what a settled wait does on
 * replay.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter, WaitFor } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { effect, isComplete, pollUntil } from "./Harness.ts"
import { layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

/** The step before a wait, so a replay that re-ran it would be visible. */
const Mark = Action.make("waitFor/mark", {
  payload: { label: Schema.String },
  success: Schema.String
})

const marks: Array<string> = []

const wired = (
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations> = Layer.empty
): Layer.Layer<
  Action.Requirement<"waitFor/mark"> | FlowRuntime.FlowRuntime | Action.Implementations,
  never,
  Crypto.Crypto
> =>
  Layer.mergeAll(
    WaitFor.layer,
    Mark.toLayer(({ label }) =>
      Effect.sync(() => {
        marks.push(label)
        return label
      })
    ),
    registration
  ).pipe(layerWired)

/** A host flow for interpretations driven outside a registered execution. */
const Host = Flow.make("waitFor/host", { payload: {}, body: () => Node.succeed(undefined) })

/** A second flow, so a token can name the running execution under a foreign flow. */
const Other = Flow.make("waitFor/other", { payload: {}, body: () => Node.succeed(undefined) })

const drive = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations
  >,
  instance: FlowRuntime.FlowInstance["Service"]
) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wired())
    )
  )

const refusal = (node: Node.Node<unknown, unknown>) =>
  Effect.gen(function*() {
    const exit = yield* drive(
      Effect.exit(Interpreter.interpret(node)),
      makeInstance(Host, "waitFor-refusal")
    )
    expect(Exit.isFailure(exit)).toBe(true)
    return Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  })

describe("WaitFor as a plan node", () => {
  const Gated = Flow.make("waitFor/plan", {
    payload: { name: Schema.String },
    success: Schema.Json,
    error: WaitFor.WaitForRequestInvalid,
    body: ({ name }) => WaitFor.action.call({ name })
  })

  it("is an ordinary declared action", () => {
    expect(WaitFor.tag).toBe("system/wait-for")
    expect(WaitFor.action.name).toBe("system/wait-for")
    expect(WaitFor.action.tier).toBe("sealed")
  })

  it("names the deferred a resolver completes", () => {
    expect(WaitFor.deferred("approval").name).toBe("WaitFor/approval")
  })

  it("appears in a built graph as a keyed action-call node", () => {
    const graph = Graph.build(Gated, { name: "approval" })
    const node = Graph.nodes(graph).find((observed) => observed.kind === "ActionCall")

    expect(graph.diagnostics).toEqual([])
    expect(node?.id).toBe("root.flow")
    expect(node?.ast).toEqual({
      _tag: "ActionCall",
      action: "system/wait-for",
      payload: { name: "approval" }
    })
    expect(node?.payload).toEqual({ name: "approval" })
    expect(Graph.drafts(graph).map((draft) => draft.id)).toContain("root.flow")
    expect(node?.draft.material.body).toMatchObject({
      _tag: "ActionCall",
      action: "system/wait-for",
      tier: "sealed"
    })
  })
})

describe("WaitFor parks", () => {
  effect("parks until the deferred is completed, then settles with the resolved value", () => {
    marks.length = 0
    const Gated = Flow.make("waitFor/gated", {
      payload: { name: Schema.String },
      success: Schema.Json,
      error: WaitFor.WaitForRequestInvalid,
      body: ({ name }) =>
        Mark.call({ label: "before" }).pipe(
          Node.bindPlanned(() => WaitFor.action.call({ name }))
        )
    })
    const executionId = "waitFor-gated"
    return Effect.gen(function*() {
      yield* Gated.execute({ name: "approval" }, { executionId, discard: true })
      yield* Effect.yieldNow
      const suspended = yield* Gated.poll(executionId)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      expect(marks).toEqual(["before"])

      // Resolution is the ordinary durable deferred completion path: a token,
      // and `DurableDeferred.succeed`.
      const gate = WaitFor.deferred("approval")
      const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Gated, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: { approved: true } })

      const result = yield* pollUntil(Gated.poll(executionId), isComplete, { turns: 20 })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toEqual({ approved: true })
      }
      // The step before the wait was journaled: the resumed round replayed its
      // recorded outcome instead of running it again.
      expect(marks).toEqual(["before"])
    }).pipe(Effect.provide(wired(Interpreter.layer(Gated))))
  })

  effect("declares the event waiting vocabulary with the wake token", () => {
    const instance = makeInstance(Host, "waitFor-annotation")
    return Effect.gen(function*() {
      const result = yield* Flow.intoResult(Interpreter.interpret(WaitFor.action.call({ name: "gate" })))
      expect(result._tag).toBe("Suspended")
      expect(instance.suspended).toBe(true)
      expect(instance.waiting).toEqual({
        reason: "event",
        token: DurableDeferred.tokenFromExecutionId(WaitFor.deferred("gate"), {
          flow: Host,
          executionId: "waitFor-annotation"
        })
      })
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wired())
    )
  })
})

describe("WaitFor replays", () => {
  it.effect("does not park again once its result is recorded", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "waitFor-replay")
      yield* drive(
        Effect.gen(function*() {
          const gate = WaitFor.deferred("recorded")
          const token = DurableDeferred.tokenFromExecutionId(gate, {
            flow: Host,
            executionId: "waitFor-replay"
          })
          yield* DurableDeferred.succeed(gate, { token, value: "already" })

          const interpretation = yield* Interpreter.interpret(WaitFor.action.call({ name: "recorded" }))
          expect(interpretation.value).toBe("already")
        }),
        instance
      )
      expect(instance.suspended).toBe(false)
      // The persisted result consumes the declared classification, so a later
      // suspension parks under its own reason.
      expect(instance.waiting).toBeUndefined()
    }))

  it.effect("awaits the wait point an absolute token names", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "waitFor-token")
      yield* drive(
        Effect.gen(function*() {
          const gate = WaitFor.deferred("by-token")
          const token = DurableDeferred.tokenFromExecutionId(gate, {
            flow: Host,
            executionId: "waitFor-token"
          })
          yield* DurableDeferred.succeed(gate, { token, value: ["resolved"] })

          const interpretation = yield* Interpreter.interpret(WaitFor.action.call({ token }))
          expect(interpretation.value).toEqual(["resolved"])
        }),
        instance
      )
      expect(instance.suspended).toBe(false)
    }))
})

describe("WaitFor refusals", () => {
  it.effect("refuses a payload that names no wait point", () =>
    Effect.gen(function*() {
      expect(yield* refusal(WaitFor.action.call({}))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/WaitForRequestInvalid",
          code: "missing_target",
          message: expect.stringContaining("neither")
        }
      })
    }))

  it.effect("refuses a payload that names both a token and a name", () =>
    Effect.gen(function*() {
      expect(
        yield* refusal(WaitFor.action.call({ name: "gate", token: "anything" }))
      ).toMatchObject({
        error: {
          _tag: "@smthrs/flow/WaitForRequestInvalid",
          code: "ambiguous_target",
          message: expect.stringContaining("one wait point")
        }
      })
    }))

  it.effect("refuses a token that is not a durable deferred token", () =>
    Effect.gen(function*() {
      expect(yield* refusal(WaitFor.action.call({ token: "not a token" }))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/WaitForRequestInvalid",
          code: "malformed_token"
        }
      })
    }))

  it.effect("refuses a token addressed to another execution", () =>
    Effect.gen(function*() {
      const foreign = DurableDeferred.tokenFromExecutionId(WaitFor.deferred("elsewhere"), {
        flow: Host,
        executionId: "some-other-execution"
      })

      expect(yield* refusal(WaitFor.action.call({ token: foreign }))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/WaitForRequestInvalid",
          code: "foreign_execution",
          message: expect.stringContaining("some-other-execution")
        }
      })
    }))

  it.effect("refuses a same-execution token addressed to another flow", () =>
    Effect.gen(function*() {
      // Completion is recorded against (flow name, execution id, deferred name),
      // so a token minted for another flow would be satisfied under that flow
      // while this one reads under its own: a park nothing ever wakes.
      const foreign = DurableDeferred.tokenFromExecutionId(WaitFor.deferred("elsewhere"), {
        flow: Other,
        executionId: "waitFor-refusal"
      })

      expect(yield* refusal(WaitFor.action.call({ token: foreign }))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/WaitForRequestInvalid",
          code: "foreign_execution",
          message: expect.stringContaining("waitFor/other")
        }
      })
    }))
})
