import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Saga from "../src/Saga.ts"
import { execute } from "./Execute.ts"
import { payloadOf } from "./Graphs.ts"

class Boom extends Schema.TaggedError<Boom>()("Boom", { step: Schema.String }) {}

// One struct covers both member roles: an action receives `{ input, completed }`
// and a compensation `{ id, input, value }`, and a `@smthrs/flow` flow states
// the payload it takes.
const StepPayload = {
  input: Schema.optional(Schema.Unknown),
  completed: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Unknown),
  value: Schema.optional(Schema.Unknown)
}

// Each flow is tagged with its own name, so a built graph can name the flow
// behind every call node. `@smthrs/flow` names a call by the flow's tag, which
// is what core's echoed body value stood in for.
const named = (name: string) =>
  Flow.make(name, {
    payload: StepPayload,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ name }, () => Node.succeed({ from: name }))
  })

const order = { input: "order" }

// The builder enters the declaration as a call of its own, so `root` is the
// saga itself rather than a step.
const calledFlows = (graph: Graph.Graph): ReadonlyArray<string> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall" && node.id !== "root")
    .map((node) => (node.ast as { readonly flow?: string }).flow!)

const declared = ["one", "two", "three"].map((id) => ({
  id,
  action: named(`do-${id}`),
  compensation: named(`undo-${id}`)
}))

// The ORDER a saga calls its steps and compensations in is a RUN-time fact: a
// flow body builds once, while the graph is planned, so a body that appends to
// an array records the build. A recording action appends when the step really
// runs.
const trace: Array<string> = []

const scriptedStep = Action.make("saga/step", {
  payload: Schema.Struct({ id: Schema.String, fails: Schema.Boolean }),
  success: Schema.Unknown,
  // A typed failure crosses the action boundary through this schema, so a
  // `Boom` is declared here rather than left to `Schema.Unknown`, which admits
  // JSON values only and refuses a class instance outright.
  error: Boom,
  tier: "irreversible"
})

const scriptedLayer = scriptedStep.toLayer((payload) =>
  Effect.suspend(() => {
    trace.push(payload.id)
    return payload.fails ? Effect.fail(new Boom({ step: payload.id })) : Effect.succeed(`${payload.id}-done`)
  })
)

const recording = (id: string, fails: boolean) =>
  Flow.make(`saga-${id}`, {
    payload: StepPayload,
    success: Schema.Unknown,
    error: Boom,
    body: Node.capture({ id, fails }, () => scriptedStep.call({ id, fails }))
  })

// The failure a step may raise that is itself a `PatternError`: it must not be
// mistaken for the saga's own `compensation_failed` refusal.
const nestedFailure = new PatternError({
  code: "compensation_failed",
  message: "An action may itself fail with a PatternError",
  cause: { failure: "nested", residue: [] }
})

const raisingStep = Action.make("saga/raise", {
  payload: Schema.Struct({ fails: Schema.Boolean }),
  success: Schema.Unknown,
  error: PatternError,
  tier: "irreversible"
})

const raisingLayer = raisingStep.toLayer(({ fails }) => fails ? Effect.fail(nestedFailure) : Effect.succeed("done"))

const raising = (fails: boolean) =>
  Flow.make(fails ? "saga-raise-fails" : "saga-raise-ok", {
    payload: StepPayload,
    success: Schema.Unknown,
    error: PatternError,
    body: Node.capture({ fails }, () => raisingStep.call({ fails }))
  })

const settled = (running: Promise<unknown>): Promise<Result.Result<unknown, unknown>> =>
  running.then((value) => Result.succeed(value), (failure: unknown) => Result.fail(failure))

// A scripted step: `fails` decides whether its action fails, and every call is
// appended to `trace` so the test can assert LIFO unwinding.
const scripted = (
  trace: Array<string>,
  id: string,
  options?: {
    readonly fails?: boolean
    readonly compensationFails?: boolean
    readonly compensationDies?: boolean
  }
) => ({
  id,
  action: () =>
    Effect.suspend(() => {
      trace.push(`do-${id}`)
      return options?.fails === true
        ? Effect.fail(new Boom({ step: id }))
        : Effect.succeed(`${id}-done`)
    }),
  compensation: () =>
    Effect.suspend(() => {
      trace.push(`undo-${id}`)
      if (options?.compensationDies === true) return Effect.die(new Error(`undo-${id} exploded`))
      return options?.compensationFails === true
        ? Effect.fail(new Boom({ step: `undo-${id}` }))
        : Effect.succeed(undefined)
    })
})

describe("Saga", () => {
  it("declares forward, unwind, and residue catches with reverse-ordered compensations", () => {
    const graph = Graph.build(Saga.make({ steps: declared, onFailure: "compensate-and-fail" }), order)

    expect(calledFlows(graph)).toEqual([
      "do-one",
      "do-two",
      "do-three",
      "undo-three",
      "undo-two",
      "undo-one"
    ])
    // Three boundaries per step (action, continuation, undo), plus reporting and clean settlement.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(11)
    expect(Graph.nodes(graph).filter((node) => node.kind === "Fail")).toHaveLength(8)
  })

  it("declares no compensation arm under the fail policy", () => {
    const graph = Graph.build(Saga.make({ steps: declared, onFailure: "fail" }), order)

    expect(calledFlows(graph)).toEqual(["do-one", "do-two", "do-three"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(0)
  })

  it("declares a settled outcome under the compensate policy", () => {
    const graph = Graph.build(Saga.make({ steps: declared, onFailure: "compensate" }), order)
    const catches = Graph.nodes(graph).filter((node) => node.kind === "Catch")
    // The clean arm of the outermost boundary. Core read it off the last node
    // of its graph; `@smthrs/flow` lists the entry call last, so the arm is
    // named instead.
    const clean = Graph.nodes(graph).find((node) => node.id === "root.flow.failure")

    expect(catches).toHaveLength(11)
    expect(clean?.kind).toBe("Succeed")
    // `@smthrs/flow` keeps a `Succeed`'s value on the node payload, where core
    // kept it inside key material, and a planned reference is a live reference
    // rather than core's `{ _tag: "PlannedInput", path }` literal.
    expect(payloadOf(clean!)._tag).toBe("Compensated")
    expect(Planned.reference(payloadOf(clean!).failure)?.path).toEqual(["failure"])
  })

  for (const onFailure of [undefined, "compensate", "compensate-and-fail"] as const) {
    it.effect(`matches declaration and runtime compensation residue under ${onFailure ?? "default"}`, () =>
      Effect.gen(function*() {
        const runtimeTrace: Array<string> = []
        const steps = [
          { id: "two", compensationFails: true },
          { id: "one", compensationFails: true },
          { id: "clean" },
          { id: "three", fails: true }
        ]
        const declaration = Saga.make({
          onFailure,
          steps: steps.map((step) => ({
            id: step.id,
            action: recording(step.id, step.fails === true),
            compensation: recording(`undo-${step.id}`, step.compensationFails === true)
          }))
        })
        const expected = new PatternError({
          code: "compensation_failed",
          message: "Saga compensation failed for: one, two",
          cause: {
            failure: new Boom({ step: "three" }),
            residue: [
              { id: "one", error: new Boom({ step: "undo-one" }) },
              { id: "two", error: new Boom({ step: "undo-two" }) }
            ]
          }
        })
        // Reusing the same declaration must not accumulate residue between executions.
        for (let attempt = 0; attempt < 2; attempt++) {
          trace.length = 0
          const reported = yield* Effect.promise(() =>
            settled(execute(declaration, order, `saga-residue-${onFailure ?? "default"}-${attempt}`, scriptedLayer))
          )
          expect(reported).toEqual(Result.fail(expected))
          expect(trace).toEqual(["two", "one", "clean", "three", "undo-clean", "undo-one", "undo-two"])
        }
        const runtime = yield* Effect.result(Saga.run("order", {
          onFailure,
          steps: steps.map((step) => scripted(runtimeTrace, step.id, step))
        }))
        expect(runtime).toEqual(Result.fail(expected))
        expect(runtimeTrace).toEqual([
          "do-two",
          "do-one",
          "do-clean",
          "do-three",
          "undo-clean",
          "undo-one",
          "undo-two"
        ])
      }))
  }

  for (const onFailure of [undefined, "compensate", "compensate-and-fail", "fail"] as const) {
    it.effect(`preserves clean declaration outcomes under ${onFailure ?? "default"}`, () =>
      Effect.gen(function*() {
        const compensation = named("undo")
        for (const failsAt of [-1, 0, 1]) {
          const declaration = Saga.make({
            onFailure,
            steps: ["one", "two"].map((id, index) => ({ id, action: raising(index === failsAt), compensation }))
          })
          // Building the conservative graph must not execute residue computations.
          Graph.build(declaration, order)
          const result = yield* Effect.promise(() =>
            settled(
              execute(declaration, order, `saga-clean-${onFailure ?? "default"}-${failsAt}`, raisingLayer)
            )
          )
          expect(result).toEqual(
            failsAt === -1
              ? Result.succeed({ _tag: "Completed", values: { one: "done", two: "done" } })
              : onFailure === "fail" || onFailure === "compensate-and-fail"
              ? Result.fail(nestedFailure)
              : Result.succeed({ _tag: "Compensated", failure: nestedFailure })
          )
        }
      }))
  }

  it.effect("collects a throwing compensation factory alongside typed undo failures", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const defect = new Error("undo-two threw")
      const result = yield* Effect.result(Saga.run("order", {
        steps: [
          scripted(trace, "one", { compensationFails: true }),
          {
            ...scripted(trace, "two"),
            compensation: (): Effect.Effect<never> => {
              trace.push("undo-two")
              throw defect
            }
          },
          scripted(trace, "three", { fails: true })
        ]
      }))
      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(result).toEqual(Result.fail(
        new PatternError({
          code: "compensation_failed",
          message: "Saga compensation failed for: one, two",
          cause: {
            failure: new Boom({ step: "three" }),
            residue: [
              { id: "one", error: new Boom({ step: "undo-one" }) },
              { id: "two", error: defect }
            ]
          }
        })
      ))
    }))

  it("keeps the caller's name and description on the declared flow", () => {
    const saga = Saga.make({
      steps: declared,
      name: "place-order",
      description: "Reserve, charge, and ship."
    })

    expect(saga._tag).toBe("place-order")
    expect(saga.description).toBe("Reserve, charge, and ship.")
    expect(Saga.make({ steps: declared }).description).toBeUndefined()
  })

  it("rejects an empty saga", () => {
    expect(() => Saga.make({ steps: [], onFailure: "compensate" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Saga requires at least one step" })
    )
  })

  it.effect("runs every step and no compensation when the saga succeeds", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const result = yield* Saga.run("order", {
        steps: [scripted(trace, "one"), scripted(trace, "two")],
        onFailure: "compensate"
      })

      expect(trace).toEqual(["do-one", "do-two"])
      expect(result).toEqual({ _tag: "Completed", values: { one: "one-done", two: "two-done" } })
    }))

  it.effect("copies and returns own completed values for prototype-shaped step ids", () =>
    Effect.gen(function*() {
      const ids = ["__proto__", "constructor", "toString", "normal"]
      const seen: Array<Readonly<Record<string, string>>> = []
      const result = yield* Saga.run<string, string, never, never, never, never>("order", {
        onFailure: "fail",
        steps: ids.map((id) => ({
          id,
          action: ({ completed }) => Effect.sync(() => (seen.push(completed), `${id}-value`)),
          compensation: () => Effect.void
        }))
      })

      for (const [index, completed] of seen.entries()) {
        expect(Object.getPrototypeOf(completed)).toBe(Object.prototype)
        expect(Object.keys(completed)).toEqual(ids.slice(0, index))
        for (const id of ids.slice(0, index)) {
          expect(Object.hasOwn(completed, id)).toBe(true)
          expect(completed[id]).toBe(`${id}-value`)
        }
      }
      expect(result._tag).toBe("Completed")
      const completed = (result as Saga.Completed<string>).values
      expect(Object.getPrototypeOf(completed)).toBe(Object.prototype)
      for (const id of ids) {
        expect(Object.hasOwn(completed, id)).toBe(true)
        expect(completed[id]).toBe(`${id}-value`)
      }
    }))

  // A saga names its own steps, so the settled arm cannot be a bare record:
  // steps called `_tag` and `failure` would otherwise return exactly the
  // compensated shape.
  it.effect("tells a completed run from a compensated one whose step ids forge it", () =>
    Effect.gen(function*() {
      const completed = yield* Saga.run("order", {
        onFailure: "compensate",
        steps: [
          { id: "_tag", action: () => Effect.succeed("Compensated"), compensation: () => Effect.void },
          { id: "failure", action: () => Effect.succeed("boom"), compensation: () => Effect.void }
        ]
      })
      const unwound = yield* Saga.run("order", {
        onFailure: "compensate",
        steps: [{ id: "a", action: () => Effect.fail("boom"), compensation: () => Effect.void }]
      })

      expect(completed).toEqual({ _tag: "Completed", values: { _tag: "Compensated", failure: "boom" } })
      expect(unwound).toEqual({ _tag: "Compensated", failure: "boom" })
      expect(completed._tag).not.toBe(unwound._tag)
    }))

  it.effect("compensates completed steps in reverse and settles under compensate", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const result = yield* Saga.run("order", {
        steps: [scripted(trace, "one"), scripted(trace, "two"), scripted(trace, "three", { fails: true })],
        onFailure: "compensate"
      })

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(result).toEqual({ _tag: "Compensated", failure: new Boom({ step: "three" }) })
    }))

  it.effect("re-fails with the original error under compensate-and-fail", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [scripted(trace, "one"), scripted(trace, "two"), scripted(trace, "three", { fails: true })],
          onFailure: "compensate-and-fail"
        })
      )

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(error).toEqual(new Boom({ step: "three" }))
    }))

  it.effect("runs no compensation under the fail policy", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [scripted(trace, "one"), scripted(trace, "two", { fails: true })],
          onFailure: "fail"
        })
      )

      expect(trace).toEqual(["do-one", "do-two"])
      expect(error).toEqual(new Boom({ step: "two" }))
    }))

  it.effect("reports a failing compensation and still runs the rest", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted(trace, "one"),
            scripted(trace, "two", { compensationFails: true }),
            scripted(trace, "three", { fails: true })
          ],
          onFailure: "compensate"
        })
      )

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: two")
      expect((error as PatternError).cause).toEqual({
        failure: new Boom({ step: "three" }),
        residue: [{ id: "two", error: new Boom({ step: "undo-two" }) }]
      })
    }))

  it.effect("sorts every failed compensation in the refusal", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted(trace, "two", { compensationFails: true }),
            scripted(trace, "one", { compensationFails: true }),
            scripted(trace, "three", { fails: true })
          ],
          onFailure: "compensate"
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: one, two")
      expect((error as PatternError).cause).toEqual({
        failure: new Boom({ step: "three" }),
        residue: [
          { id: "one", error: new Boom({ step: "undo-one" }) },
          { id: "two", error: new Boom({ step: "undo-two" }) }
        ]
      })
    }))

  it.effect("reports compensation residue without inventing a typed failure for a defect", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted([], "one", { compensationFails: true }),
            {
              id: "two",
              action: () => Effect.die(new Error("forward defect")),
              compensation: () => Effect.void
            }
          ],
          onFailure: "compensate"
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: one")
      expect((error as PatternError).cause).toEqual({
        residue: [{ id: "one", error: new Boom({ step: "undo-one" }) }]
      })
    }))

  it.effect("propagates a forward defect when every compensation succeeds", () =>
    Effect.gen(function*() {
      const defect = new Error("forward defect")
      const exit = yield* Effect.exit(
        Saga.run("order", {
          steps: [{ id: "one", action: () => Effect.die(defect), compensation: () => Effect.void }],
          onFailure: "compensate"
        })
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // The forward defect reaches the caller unwrapped: `compensate` turns a
        // typed failure into `Compensated`, and a defect is not a typed failure.
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
      }
    }))

  it.effect("does not admit a step appended while the run is in flight", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const steps: Array<Saga.RuntimeStep<string, string, never, never, never, never>> = []
      const late: Saga.RuntimeStep<string, string, never, never, never, never> = {
        id: "late",
        action: () => Effect.sync(() => (trace.push("late"), "late-done")),
        compensation: () => Effect.void
      }
      steps.push({
        id: "one",
        action: () => Effect.sync(() => (trace.push("one"), steps.push(late), "one-done")),
        compensation: () => Effect.void
      })

      const result = yield* Saga.run("order", { steps, onFailure: "fail" })

      expect(trace).toEqual(["one"])
      expect(result).toEqual({ _tag: "Completed", values: { one: "one-done" } })
    }))

  it.effect("compensates completed steps when the forward chain is interrupted", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const fiber = yield* Effect.forkChild(
        Saga.run("order", {
          steps: [
            scripted(trace, "one"),
            {
              id: "two",
              action: () => Effect.never,
              compensation: () => Effect.sync(() => trace.push("undo-two"))
            }
          ],
          onFailure: "compensate"
        }),
        { startImmediately: true }
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)

      expect(trace).toEqual(["do-one", "undo-one"])
    }))

  // `run` refuses with a TYPED failure, not a defect: `PatternError` is in the
  // declared error channel, so a caller must be able to claim it.
  it.effect("fails run with a typed PatternError for an empty saga and for duplicate step ids", () =>
    Effect.gen(function*() {
      const empty = yield* Effect.flip(
        Saga.run("order", {
          steps: [] as ReadonlyArray<Saga.RuntimeStep<string, string, never, never, never, never>>,
          onFailure: "compensate"
        })
      )
      const step: Saga.RuntimeStep<string, string, never, never, never, never> = {
        id: "one",
        action: () => Effect.succeed("done"),
        compensation: () => Effect.void
      }
      const duplicate = yield* Effect.flip(Saga.run("order", { steps: [step, step], onFailure: "compensate" }))

      expect(empty).toBeInstanceOf(PatternError)
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("Saga requires at least one step")
      expect(duplicate).toBeInstanceOf(PatternError)
      expect(duplicate.code).toBe("invalid_decorator")
      expect(duplicate.message).toBe("Saga step ids must be unique")
    }))
  it("defaults an omitted policy to compensate in the declaration", () => {
    const graph = Graph.build(Saga.make({ steps: declared }), order)
    const explicit = Graph.build(Saga.make({ steps: declared, onFailure: "compensate" }), order)

    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(11)
    expect(calledFlows(graph)).toEqual(calledFlows(explicit))
    // The default is normalized before it reaches key material, so omitting
    // the policy and naming it plan to the same node keys and hit the same
    // cache entries.
    expect(Graph.nodes(graph).map((node) => node.draft.material)).toEqual(
      Graph.nodes(explicit).map((node) => node.draft.material)
    )
  })

  // `@smthrs/core`'s refusal named a core flow. A member is now a flow or an
  // action, and both record a call through their own `.call`, so the refusal
  // names that instead. A bare function inherits `Function.prototype.call` and
  // is still refused.
  it("refuses a step whose action or compensation cannot record a call", () => {
    const notAMember = (() => Node.succeed(1)) as unknown as Saga.Step["action"]
    const notAnObject = "do-one" as unknown as Saga.Step["action"]

    for (
      const [step, message] of [
        [
          { id: "one", action: notAMember, compensation: named("undo-one") },
          "Saga step \"one\" action must be a flow or an action"
        ],
        [
          { id: "one", action: named("do-one"), compensation: notAMember },
          "Saga step \"one\" compensation must be a flow or an action"
        ],
        [
          { id: "one", action: notAnObject, compensation: named("undo-one") },
          "Saga step \"one\" action must be a flow or an action"
        ]
      ] as const
    ) {
      let refusal: unknown
      try {
        Saga.make({ steps: [step], onFailure: "compensate" })
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(PatternError)
      expect((refusal as PatternError).code).toBe("invalid_decorator")
      expect((refusal as PatternError).message).toBe(message)
    }
  })

  it.effect("defaults an omitted policy to compensate at run time", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const result = yield* Saga.run("order", {
        steps: [scripted(trace, "one"), scripted(trace, "two"), scripted(trace, "three", { fails: true })]
      })

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(result).toEqual({ _tag: "Compensated", failure: new Boom({ step: "three" }) })
    }))

  // A compensation that DIES is a failed compensation: the step's undo did not
  // happen, so it belongs in the residue like a typed failure. Letting the
  // defect escape would lose both the residue and the original failure.
  it.effect("reports a compensation that dies and still runs the rest", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const error = yield* Effect.flip(
        Saga.run("order", {
          steps: [
            scripted(trace, "one"),
            scripted(trace, "two", { compensationDies: true }),
            scripted(trace, "three", { fails: true })
          ],
          onFailure: "compensate"
        })
      )

      expect(trace).toEqual(["do-one", "do-two", "do-three", "undo-two", "undo-one"])
      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("compensation_failed")
      expect((error as PatternError).message).toBe("Saga compensation failed for: two")
    }))

  it("declares from the snapshot make took of its steps", () => {
    const steps = declared.map((step) => ({ ...step }))
    const saga = Saga.make({ steps, onFailure: "compensate-and-fail" })
    const before = Graph.nodes(Graph.build(saga, order)).map((node) => node.draft.material.body)

    // A swapped action, a swapped compensation, and an appended step, all
    // after the call.
    steps[0]!.action = named("do-elsewhere")
    steps[1]!.compensation = named("undo-elsewhere")
    steps.push({ id: "four", action: named("do-four"), compensation: named("undo-four") })

    const graph = Graph.build(saga, order)
    expect(Graph.nodes(graph).map((node) => node.draft.material.body)).toEqual(before)
    expect(calledFlows(graph)).toEqual(["do-one", "do-two", "do-three", "undo-three", "undo-two", "undo-one"])
  })

  it.effect("runs the snapshot run took of its steps", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const steps = [scripted(trace, "one")]
      const options = { steps, onFailure: "fail" as const }
      const saga = Saga.run("order", options)

      // A swapped action and an appended step, between the call and the
      // execution.
      steps[0]!.action = () => Effect.sync(() => (trace.push("do-swapped"), "swapped"))
      steps.push(scripted(trace, "late"))

      const result = yield* saga
      expect(trace).toEqual(["do-one"])
      expect(result).toEqual({ _tag: "Completed", values: { one: "one-done" } })
    }))
})
