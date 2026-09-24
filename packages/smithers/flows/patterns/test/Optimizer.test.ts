/**
 * `Optimizer` on `@smthrs/flow`'s `Graph.build`.
 *
 * The declaration assertions are the same observable facts as before: one
 * generate and one evaluate call per declared iteration, and the next
 * generation reading the previous attempt by field. The executed cases run
 * the declaration and {@link Optimizer.run} on the same scripted scores and
 * require the same outcome: the target check and the best-so-far fold happen
 * on real values in both.
 */
import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Optimizer from "../src/Optimizer.ts"
import { PatternError } from "../src/PatternError.ts"
import { execute, member } from "./Execute.ts"
import { callsTo } from "./Graphs.ts"

/** The generate member: it is handed `{ input, previous, iteration }`. */
const generate = Flow.make("optimizer/generate", {
  payload: { input: Schema.Unknown, previous: Schema.Unknown, iteration: Schema.Number },
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

const scripted = (scores: ReadonlyArray<number>) => ({
  generate: ({ iteration }: { readonly iteration: number }) => Effect.succeed(`candidate-${iteration}`),
  evaluate: ({ iteration }: { readonly iteration: number }) =>
    Effect.succeed({ score: scores[iteration - 1]!, feedback: `feedback-${iteration}` })
})

/**
 * Counts the candidates a run still holds. A WeakRef keeps its target alive
 * for the rest of the job that created it, so the count is taken from a later
 * job, after a forced collection.
 */
const liveCandidates = async (refs: ReadonlyArray<WeakRef<object>>): Promise<number> => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc === undefined) {
    // Without a real collection the count measures collector scheduling, not
    // retention; refuse rather than flake.
    throw new Error(
      "Optimizer retention needs --expose-gc; run through this package's vitest config, which sets it"
    )
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  gc()
  return refs.filter((ref) => ref.deref() !== undefined).length
}

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
      candidate: { _tag: "PlannedInput", path: [] },
      score: { _tag: "PlannedInput", path: ["score"] },
      feedback: { _tag: "PlannedInput", path: ["feedback"] },
      iteration: 1
    })
  })

  it("rejects an optimizer bound below one iteration", () => {
    expect(() =>
      Optimizer.make({ generate, evaluate, targetScore: 0.8, maxIterations: 0, onMaxReached: "return-last" })
    )
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Optimizer maxIterations must be a positive safe integer"
      }))
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

  it.effect("stops at the first candidate that reaches the target", () =>
    Effect.gen(function*() {
      const evaluated: Array<number> = []
      const script = scripted([0.2, 0.9, 0.5])
      const result = yield* Optimizer.run("prompt", {
        maxIterations: 3,
        onMaxReached: "return-last",
        targetScore: 0.8,
        generate: script.generate,
        evaluate: (input) => {
          evaluated.push(input.iteration)
          return script.evaluate(input)
        }
      })

      expect(result.converged).toBe(true)
      expect(result.iterations).toBe(2)
      expect(result.best).toEqual({
        candidate: "candidate-2",
        score: 0.9,
        feedback: "feedback-2",
        iteration: 2
      })
      expect(evaluated).toEqual([1, 2])
    }))

  it.effect("keeps the best candidate when no target is set", () =>
    Effect.gen(function*() {
      const script = scripted([0.2, 0.9, 0.5])
      const result = yield* Optimizer.run("prompt", {
        maxIterations: 3,
        onMaxReached: "return-last",
        ...script
      })

      expect(result.iterations).toBe(3)
      expect(result.converged).toBe(false)
      expect(result.best.score).toBe(0.9)
      expect(result.best.iteration).toBe(2)
    }))

  it.effect("keeps the earliest of two equal best scores", () =>
    Effect.gen(function*() {
      const result = yield* Optimizer.run("prompt", {
        maxIterations: 3,
        onMaxReached: "return-last",
        ...scripted([0.5, 0.3, 0.5])
      })

      // A later attempt has to beat the standing best, not merely match it, so
      // a tie resolves the same way wherever it falls in the search.
      expect(result.best.score).toBe(0.5)
      expect(result.best.iteration).toBe(1)
      expect(result.best.candidate).toBe("candidate-1")
    }))

  it.effect("keeps the earliest of equal scores when the tie ends the search", () =>
    Effect.gen(function*() {
      const result = yield* Optimizer.run("prompt", {
        maxIterations: 3,
        onMaxReached: "return-last",
        ...scripted([0.5, 0.5, 0.3])
      })

      expect(result.best.iteration).toBe(1)
    }))

  it.effect("fails exhausted when the target is never reached", () =>
    Effect.gen(function*() {
      const failure = yield* Optimizer.run("prompt", {
        maxIterations: 3,
        onMaxReached: "fail",
        targetScore: 0.95,
        ...scripted([0.2, 0.9, 0.5])
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("exhausted")
      expect(failure.message).toBe("Optimizer reached its bound of 3 iterations below 0.95")
    }))

  it.effect("feeds the previous score and feedback into the next generate call", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const script = scripted([0.2, 0.4, 0.5])
      yield* Optimizer.run("prompt", {
        maxIterations: 3,
        onMaxReached: "return-last",
        targetScore: 0.9,
        evaluate: script.evaluate,
        generate: (input) => {
          seen.push(input.previous)
          return script.generate(input)
        }
      })

      expect(seen).toEqual([
        undefined,
        { candidate: "candidate-1", score: 0.2, feedback: "feedback-1", iteration: 1 },
        { candidate: "candidate-2", score: 0.4, feedback: "feedback-2", iteration: 2 }
      ])
    }))

  it.effect("refuses non-finite evaluator scores with the iteration and value", () =>
    Effect.gen(function*() {
      for (const score of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const failure = yield* Effect.flip(
          Optimizer.run("prompt", {
            maxIterations: 3,
            onMaxReached: "return-last",
            generate: ({ iteration }) => Effect.succeed(`candidate-${iteration}`),
            evaluate: ({ iteration }) => Effect.succeed({ score, feedback: iteration })
          })
        )

        expect(failure).toBeInstanceOf(PatternError)
        expect(failure.code).toBe("invalid_input")
        expect(failure.message).toBe(
          `Optimizer evaluation score at iteration 1 must be a finite number, received ${score}`
        )
      }
    }))

  it.effect("picks the same best across a scripted sequence whose plateau repeats", () =>
    Effect.gen(function*() {
      const result = yield* Optimizer.run("prompt", {
        maxIterations: 6,
        onMaxReached: "return-last",
        ...scripted([0.1, 0.7, 0.4, 0.7, 0.2, 0.7])
      })

      expect(result.best).toEqual({
        candidate: "candidate-2",
        score: 0.7,
        feedback: "feedback-2",
        iteration: 2
      })
      expect(result.iterations).toBe(6)
      expect(result.converged).toBe(false)
    }))

  it.effect("releases a candidate the search has already lost", () =>
    Effect.gen(function*() {
      const bound = 32
      const refs: Array<WeakRef<{ readonly iteration: number }>> = []
      let live = -1
      const result = yield* Optimizer.run("prompt", {
        maxIterations: bound,
        onMaxReached: "return-last",
        generate: ({ iteration }) =>
          Effect.sync(() => {
            const candidate = { iteration }
            refs.push(new WeakRef(candidate))
            return candidate
          }),
        // Every score is worse than the one before it, so iteration 1 stays
        // best and every later candidate is one the search has no reason to
        // hold.
        evaluate: ({ iteration }) =>
          Effect.promise(async () => {
            if (iteration === bound) live = await liveCandidates(refs)
            return { score: -iteration }
          })
      })

      expect(result.best.iteration).toBe(1)
      expect(live).toBeGreaterThan(0)
      // The best attempt, the previous one, and the one being scored. A count
      // that tracks the bound instead means the run is keeping a ledger of
      // every candidate it has produced.
      expect(live).toBeLessThanOrEqual(3)
    }))

  it.effect("validates the target score and the bound before generating", () =>
    Effect.gen(function*() {
      let generated = 0
      const script = scripted([1])
      const options = {
        evaluate: script.evaluate,
        generate: (input: { readonly iteration: number }) => {
          generated++
          return script.generate(input)
        }
      }
      const noTarget = yield* Optimizer.run("prompt", { ...options, maxIterations: 1, onMaxReached: "fail" }).pipe(
        Effect.flip
      )
      const badBound = yield* Optimizer.run("prompt", {
        ...options,
        maxIterations: 0,
        onMaxReached: "return-last"
      }).pipe(Effect.flip)
      const nonFinite = yield* Optimizer.run("prompt", {
        ...options,
        targetScore: Number.POSITIVE_INFINITY,
        maxIterations: 1,
        onMaxReached: "return-last"
      }).pipe(Effect.flip)

      expect(noTarget.code).toBe("invalid_decorator")
      expect(noTarget.message).toBe("Optimizer onMaxReached 'fail' requires a targetScore to fall short of")
      expect(badBound.code).toBe("invalid_decorator")
      expect(badBound.message).toBe("Optimizer maxIterations must be a positive safe integer")
      expect(nonFinite.code).toBe("invalid_decorator")
      expect(nonFinite.message).toBe("Optimizer targetScore must be a finite number")
      expect(generated).toBe(0)
    }))

  // Loop defaults `onMaxReached` to "return-last"; Optimizer required it, so a
  // reader who learned one bound could not predict the other.
  it("defaults onMaxReached to return-last in make, as Loop does", () => {
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

  it.effect("defaults onMaxReached to return-last in run, as Loop does", () =>
    Effect.gen(function*() {
      const result = yield* Optimizer.run("prompt", {
        maxIterations: 2,
        targetScore: 1,
        generate: ({ iteration }) => Effect.succeed(`draft ${iteration}`),
        evaluate: ({ iteration }: { readonly iteration: number }) => Effect.succeed({ score: iteration / 10 })
      })

      expect(result.converged).toBe(false)
      expect(result.iterations).toBe(2)
      expect(result.best.candidate).toBe("draft 2")
    }))

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

  describe("executed declaration matches run on the same scripted scores", () => {
    // Members answer from the literal iteration a declaration hands them, so a
    // scripted score is a real value by the time the ledger folds it.
    const declared = (scores: ReadonlyArray<number>) => ({
      generate: member(
        "optimizer/scripted-generate",
        ({ iteration }) => `candidate-${iteration}`,
        { input: Schema.Unknown, previous: Schema.Unknown, iteration: Schema.Number }
      ),
      evaluate: member(
        "optimizer/scripted-evaluate",
        ({ iteration }) => ({ score: scores[iteration - 1]!, feedback: `feedback-${iteration}` }),
        { value: Schema.Unknown, iteration: Schema.Number }
      )
    })
    const settle = (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runPromise(Effect.match(effect, { onFailure: (error) => ({ failed: error }), onSuccess: (ok) => ok }))
    const both = async (
      scores: ReadonlyArray<number>,
      options: { readonly targetScore?: number; readonly maxIterations: number; readonly onMaxReached?: "fail" }
    ) => {
      const flow = Optimizer.make({ ...declared(scores), ...options })
      const executed = await execute(flow, { input: "prompt" }, `optimizer-${scores.join("-")}-${options.onMaxReached}`)
        .then((ok) => ok, (error: unknown) => ({ failed: error }))
      const ran = await settle(Optimizer.run("prompt", { ...scripted(scores), ...options }))
      return { executed, ran }
    }

    it("stops at the first candidate that reaches the target", async () => {
      const { executed, ran } = await both([1, 0, 0], { targetScore: 0.9, maxIterations: 3, onMaxReached: "fail" })
      expect(executed).toEqual({
        best: { candidate: "candidate-1", score: 1, feedback: "feedback-1", iteration: 1 },
        iterations: 1,
        converged: true
      })
      expect(executed).toEqual(ran)
    })

    it("reports the best attempt, not the last, when the bound is reached", async () => {
      const { executed, ran } = await both([0.2, 0.7, 0.4], { maxIterations: 3 })
      expect(executed).toEqual({
        best: { candidate: "candidate-2", score: 0.7, feedback: "feedback-2", iteration: 2 },
        iterations: 3,
        converged: false
      })
      expect(executed).toEqual(ran)
    })

    it("fails exhausted at the bound under onMaxReached fail", async () => {
      const { executed, ran } = await both([0.2, 0.7], { targetScore: 0.9, maxIterations: 2, onMaxReached: "fail" })
      expect(executed).toMatchObject({
        failed: { code: "exhausted", message: "Optimizer reached its bound of 2 iterations below 0.9" }
      })
      expect(ran).toMatchObject({ failed: { code: "exhausted" } })
    })

    it("refuses a non-finite score", async () => {
      const { executed, ran } = await both([0.2, Number.POSITIVE_INFINITY, 1], { maxIterations: 3 })
      const message = "Optimizer evaluation score at iteration 2 must be a finite number, received Infinity"
      expect(executed).toMatchObject({ failed: { code: "invalid_input", message } })
      expect(ran).toMatchObject({ failed: { code: "invalid_input", message } })
    })
  })
})
