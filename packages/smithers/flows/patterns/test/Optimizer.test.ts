import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Optimizer from "../src/Optimizer.ts"
import { PatternError } from "../src/PatternError.ts"

const generate = Flow.make({
  name: "generate",
  capabilities: ["optimizer/generate"],
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const evaluate = Flow.make({
  name: "evaluate",
  capabilities: ["optimizer/evaluate"],
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

const literalInput = (node: Graph.GraphNode): Record<string, unknown> => {
  const literal = node.keyMaterial.inputs.find((input) => input._tag === "Literal")
  return (literal as { readonly value: Record<string, unknown> }).value
}

const callsTo = (graph: Graph.Graph, capability: string): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    node.kind === "FlowCall" &&
    (node.keyMaterial.body as { readonly capabilities?: ReadonlyArray<string> }).capabilities?.includes(capability) ===
      true
  )

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
    const graph = Graph.build(optimizer, "prompt")

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
    const graph = Graph.build(optimizer, "prompt")
    const generates = callsTo(graph, "optimizer/generate")
    const evaluates = callsTo(graph, "optimizer/evaluate")
    const refs = generates[1]!.keyMaterial.inputs.filter((input) => input._tag === "Ref")

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
      Graph.nodes(
        Graph.build(
          Optimizer.make({ generate, evaluate, targetScore, maxIterations: 2, onMaxReached: "return-last" }),
          "prompt"
        )
      )[0]?.keyMaterial.body

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
    expect(callsTo(Graph.build(targetFree, "prompt"), "optimizer/generate")).toHaveLength(2)
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
})
