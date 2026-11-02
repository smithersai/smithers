/**
 * `Optimizer` on `@smthrs/flow`'s `Graph.build`.
 *
 * The declaration assertions are the same observable facts as before: one
 * generate and one evaluate call per declared iteration, and the next
 * generation reading the previous attempt by field. The executed cases run
 * the declaration on scripted scores through the engine. The target check and
 * the best-so-far fold operate on real values.
 */
import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Optimizer from "../src/Optimizer.ts"
import { PatternError } from "../src/PatternError.vibe"
import { execute, executeExit, member } from "./Execute.ts"
import { callsTo } from "./Graphs.ts"

/** The generate member: it is handed `{ input, previous, iteration }`. */
const generate = Flow.make("optimizer/generate", {
  payload: { input: Schema.Unknown, previous: Schema.optional(Schema.Unknown), iteration: Schema.Number },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: Node.capture({}, ({ iteration }: { readonly iteration: number }) => Node.succeed({ candidate: iteration }))
})

/** The evaluate member: it is handed `{ value, iteration }`. */
const evaluate = Flow.make("optimizer/evaluate", {
  payload: { value: Schema.Unknown, iteration: Schema.Number },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: Node.capture(
    {},
    ({ iteration }: { readonly iteration: number }) =>
      Node.succeed({ score: iteration, feedback: `feedback-${iteration}` })
  )
})

/**
 * What a node's key material states.
 *
 * `@smthrs/core`'s `keyMaterial` is `@smthrs/flow`'s `draft.material`, with the
 * same `Literal` and `Ref` input vocabulary, so these assertions translate name
 * for name.
 */
const material = (node: Graph.GraphNode): {
  readonly body: unknown
  readonly inputs: ReadonlyArray<{ readonly _tag: string }>
} => node.draft.material as never

const literalInput = (node: Graph.GraphNode): Record<string, unknown> =>
  (material(node).inputs.find((input) => input._tag === "Literal") as unknown as {
    readonly value: Record<string, unknown>
  }).value

const refInputs = (node: Graph.GraphNode): ReadonlyArray<unknown> =>
  material(node).inputs.filter((input) => input._tag === "Ref")

/** The node the optimizer itself is entered as, which carries its captures. */
const entry = (graph: Graph.Graph): Graph.GraphNode =>
  Graph.nodes(graph).find((node) => node.id === "root") as Graph.GraphNode

describe("Optimizer", () => {
  it("declares one generate and one evaluate call per iteration", () => {
    const optimizer = Optimizer.make({
      generate,
      evaluate,
      targetScore: 0.8,
      maxIterations: 3,
      onMaxReached: "return-last"
    })
    const graph = Graph.build(optimizer, { input: "prompt" })

    expect(Flow.isFlow(optimizer)).toBe(true)
    expect(callsTo(graph, "optimizer/generate")).toHaveLength(3)
    expect(callsTo(graph, "optimizer/evaluate")).toHaveLength(3)
  })

  it("declares the next generate call as reading the previous evaluation", () => {
    const optimizer = Optimizer.make({
      generate,
      evaluate,
      targetScore: 0.8,
      maxIterations: 2,
      onMaxReached: "return-last"
    })
    const graph = Graph.build(optimizer, { input: "prompt" })
    const generates = callsTo(graph, "optimizer/generate")
    const evaluates = callsTo(graph, "optimizer/evaluate")
    const refs = refInputs(generates[1]!)

    expect(refs).toContainEqual({ _tag: "Ref", from: evaluates[0]!.id, path: ["score"] })
    expect(refs).toContainEqual({ _tag: "Ref", from: evaluates[0]!.id, path: ["feedback"] })
    expect(refs).toContainEqual({ _tag: "Ref", from: generates[0]!.id, path: [] })
    expect(literalInput(generates[1]!).previous).toEqual({
      candidate: { _tag: "PlannedInput", input: 0, path: [] },
      score: { _tag: "PlannedInput", input: 2, path: ["score"] },
      feedback: { _tag: "PlannedInput", input: 1, path: ["feedback"] },
      iteration: 1
    })
  })

  it("rejects invalid iteration bounds", () => {
    for (const maxIterations of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Optimizer.make({ generate, evaluate, targetScore: 0.8, maxIterations }))
        .toThrow(expect.objectContaining({
          code: "invalid_decorator",
          message: "Optimizer maxIterations must be a positive safe integer"
        }))
    }
  })

  it("makes the target score part of declaration identity", () => {
    const body = (targetScore: number): unknown =>
      material(
        entry(
          Graph.build(
            Optimizer.make({ generate, evaluate, targetScore, maxIterations: 2, onMaxReached: "return-last" }),
            { input: "prompt" }
          )
        )
      ).body

    expect(body(0.8)).not.toEqual(body(0.9))
  })

  it("rejects a fail policy with no target score", () => {
    expect(() => Optimizer.make({ generate, evaluate, maxIterations: 2, onMaxReached: "fail" })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Optimizer onMaxReached 'fail' requires a targetScore to fall short of"
      })
    )
  })

  it("refuses a non-finite target and declares a target-free return-last search", () => {
    expect(() =>
      Optimizer.make({
        generate,
        evaluate,
        targetScore: Number.NaN,
        maxIterations: 2,
        onMaxReached: "return-last"
      })
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Optimizer targetScore must be a finite number"
      })
    )

    const targetFree = Optimizer.make({ generate, evaluate, maxIterations: 2, onMaxReached: "return-last" })
    expect(callsTo(Graph.build(targetFree, { input: "prompt" }), "optimizer/generate")).toHaveLength(2)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = Optimizer.make({
      name: "tune-prompt",
      description: "Generate a prompt, score it, try again.",
      generate,
      evaluate,
      maxIterations: 2
    })

    expect(named._tag).toBe("tune-prompt")
    expect(named.description).toBe("Generate a prompt, score it, try again.")
    const derived = Optimizer.make({ generate, evaluate, maxIterations: 2 })
    expect(derived._tag).toBe("optimizer(maxIterations=2, onMaxReached=return-last)")
    expect(derived.description).toBeUndefined()
  })

  it("defaults onMaxReached to return-last in make", () => {
    const optimizer = Optimizer.make({ generate, evaluate, targetScore: 0.8, maxIterations: 2 })
    const explicit = Optimizer.make({
      generate,
      evaluate,
      targetScore: 0.8,
      maxIterations: 2,
      onMaxReached: "return-last"
    })

    const shape = (flow: typeof optimizer) =>
      Graph.nodes(Graph.build(flow, { input: "prompt" })).map((node) => node.draft.material)
    expect(shape(optimizer)).toEqual(shape(explicit))
  })

  it("builds the deepest bound it accepts and refuses the next one", () => {
    // Each iteration nests three levels (the generate bind, the evaluate bind,
    // and the branch), so `Graph.maximumGraphDepth` (1000) admits 332.
    expect(
      callsTo(
        Graph.build(Optimizer.make({ generate, evaluate, maxIterations: 332 }), { input: "p" }),
        "optimizer/generate"
      )
    )
      .toHaveLength(332)
    expect(() => Optimizer.make({ generate, evaluate, maxIterations: 333 })).toThrow(
      new PatternError({
        code: "invalid_decorator",
        message: "Optimizer maxIterations must be at most 332 to stay inside the plan depth limit, received 333"
      })
    )
  })

  describe("executed declaration on scripted scores", () => {
    it("propagates the evaluator's typed error", async () => {
      class EvaluationFailed extends Schema.TaggedError<EvaluationFailed>()("EvaluationFailed", {
        reason: Schema.String
      }) {}
      const error = new EvaluationFailed({ reason: "scorer unavailable" })
      const Evaluate = Action.make("optimizer/failing-evaluate", {
        payload: { value: Schema.Unknown, iteration: Schema.Number },
        success: Schema.Struct({ score: Schema.Number, feedback: Schema.String }),
        error: EvaluationFailed
      })
      const optimizer = Optimizer.make<Action.Requirement<"optimizer/failing-evaluate">>({
        generate,
        evaluate: Evaluate,
        targetScore: 0.9,
        maxIterations: 3
      })
      const exit = await executeExit(
        optimizer,
        { input: "prompt" },
        "optimizer-evaluator-failure",
        Evaluate.toLayer(() => Effect.fail(error))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(error))
      }
    })

    // Members answer from the literal iteration a declaration hands them, so a
    // scripted score is a real value by the time the ledger folds it.
    const declared = (scores: ReadonlyArray<number>) => ({
      generate: member(
        "optimizer/scripted-generate",
        ({ iteration }) => `candidate-${iteration}`,
        { input: Schema.Unknown, previous: Schema.optional(Schema.Unknown), iteration: Schema.Number }
      ),
      evaluate: member(
        "optimizer/scripted-evaluate",
        ({ iteration }) => ({ score: scores[iteration - 1]!, feedback: `feedback-${iteration}` }),
        { value: Schema.Unknown, iteration: Schema.Number }
      )
    })
    const runDeclared = async (
      scores: ReadonlyArray<number>,
      options: { readonly targetScore?: number; readonly maxIterations: number; readonly onMaxReached?: "fail" }
    ) => {
      const flow = Optimizer.make({ ...declared(scores), ...options })
      return execute(flow, { input: "prompt" }, `optimizer-${scores.join("-")}-${options.onMaxReached}`)
        .then((ok) => ok, (error: unknown) => ({ failed: error }))
    }

    it("stops at the first candidate that reaches the target", async () => {
      const executed = await runDeclared([1, 0, 0], { targetScore: 0.9, maxIterations: 3, onMaxReached: "fail" })
      expect(executed).toEqual({
        best: { candidate: "candidate-1", score: 1, feedback: "feedback-1", iteration: 1 },
        iterations: 1,
        converged: true
      })
    })

    it("reports the best attempt, not the last, when the bound is reached", async () => {
      const executed = await runDeclared([0.2, 0.7, 0.4], { maxIterations: 3 })
      expect(executed).toEqual({
        best: { candidate: "candidate-2", score: 0.7, feedback: "feedback-2", iteration: 2 },
        iterations: 3,
        converged: false
      })
    })

    it("keeps the earliest best across equal scores and a repeated plateau", async () => {
      for (const scores of [[0.5, 0.3, 0.5], [0.5, 0.5, 0.3], [0.1, 0.7, 0.4, 0.7, 0.2, 0.7]]) {
        const firstBest = scores.indexOf(Math.max(...scores)) + 1
        expect(await runDeclared(scores, { maxIterations: scores.length })).toMatchObject({
          best: { candidate: `candidate-${firstBest}`, score: scores[firstBest - 1], iteration: firstBest },
          iterations: scores.length,
          converged: false
        })
      }
    })

    it("passes the previous attempt and stops before generating after the target", async () => {
      const Generate = Action.make("optimizer/record-generate", {
        payload: { input: Schema.Unknown, previous: Schema.optional(Schema.Unknown), iteration: Schema.Number },
        success: Schema.String
      })
      const seen: Array<unknown> = []
      const flow = Optimizer.make<Action.Requirement<"optimizer/record-generate">>({
        generate: Generate,
        evaluate: declared([0.2, 0.9, 0.1]).evaluate,
        targetScore: 0.8,
        maxIterations: 3
      })
      const result = await execute(
        flow,
        { input: "prompt" },
        "optimizer-feedback",
        Generate.toLayer((payload) =>
          Effect.sync(() => {
            seen.push(payload.previous)
            return `candidate-${payload.iteration}`
          })
        )
      )
      expect(result).toEqual({
        best: { candidate: "candidate-2", score: 0.9, feedback: "feedback-2", iteration: 2 },
        iterations: 2,
        converged: true
      })
      expect(seen).toEqual([
        undefined,
        { candidate: "candidate-1", score: 0.2, feedback: "feedback-1", iteration: 1 }
      ])
    })

    it("fails exhausted at the bound under onMaxReached fail", async () => {
      const executed = await runDeclared([0.2, 0.7], { targetScore: 0.9, maxIterations: 2, onMaxReached: "fail" })
      expect(executed).toMatchObject({
        failed: { code: "exhausted", message: "Optimizer reached its bound of 2 iterations below 0.9" }
      })
    })

    it("refuses a non-finite score", async () => {
      for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const executed = await runDeclared([0.2, score, 1], { maxIterations: 3 })
        const message = `Optimizer evaluation score at iteration 2 must be a finite number, received ${score}`
        expect(executed).toMatchObject({ failed: { code: "invalid_input", message } })
      }
    })
  })
})
