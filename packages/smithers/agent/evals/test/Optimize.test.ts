import * as Binding from "@smthrs/scorers/Binding"
import * as Scorer from "@smthrs/scorers/Scorer"
import { ScorerError } from "@smthrs/scorers/ScorerError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { CaseExecutor, Optimize, Suite } from "../src/index.ts"

const target = { name: "target" }
const scorer = Scorer.make({
  id: "packages/smithers/agent/evals/test/Optimize/numeric",
  name: "numeric",
  version: "1",
  score: ({ output, input }) =>
    input === "unscorable"
      ? Effect.fail(new ScorerError({ code: "inconclusive", message: "No reference score" }))
      : Effect.succeed({ score: Number(output) * Number(input) })
})
const binding = Binding.make({ scorer, appliesTo: target })

const optionsFor = async (bindings: ReadonlyArray<Suite.Binding> = [binding]): Promise<Optimize.Options> => ({
  suite: await Effect.runPromise(Suite.make({
    name: "prompt-optimization",
    concurrency: 1,
    bindings,
    cases: [
      { name: "full", input: 1 },
      { name: "half", input: 0.5 },
      { name: "unscorable", input: "unscorable" }
    ]
  })),
  initialPrompt: "0.5",
  evaluatePrompt: (prompt) =>
    CaseExecutor.make((suiteCase) => Effect.succeed({ output: prompt, stepKey: suiteCase.name, latencyMs: 0, target })),
  propose: () => Effect.die("Unexpected proposal"),
  maxIterations: 1,
  runIdPrefix: "optimize",
  at: "2026-01-01T00:00:00.000Z"
})

describe("Optimize", () => {
  it("converges at the exact target and exposes the completed run to the proposer", async () => {
    const options = await optionsFor()
    const contexts: Array<Optimize.ProposeContext> = []
    const result = await Effect.runPromise(Optimize.run({
      ...options,
      maxIterations: 3,
      targetScore: 0.75,
      onMaxReached: "fail",
      propose: (context) =>
        Effect.sync(() => {
          contexts.push(context)
          return "1"
        })
    }))
    expect(result).toMatchObject({ _tag: "Converged", bestPrompt: "1", bestScore: 0.75 })
    const [first, winner] = result.history
    expect(result.history).toHaveLength(2)
    expect(first).toMatchObject({ iteration: 1, prompt: "0.5", score: 0.375, run: { runId: "optimize-1" } })
    expect(winner).toMatchObject({ iteration: 2, prompt: "1", score: 0.75, run: { runId: "optimize-2" } })
    expect(result.bestRun).toBe(winner?.run)
    expect(result.bestRun.observations.map(({ kind, at }) => [kind, at])).toEqual([
      ["score", options.at],
      ["score", options.at],
      ["inconclusive", options.at]
    ])
    expect(Optimize.meanScore(result.bestRun)).toBe(0.75)
    expect(contexts).toEqual([{
      bestPrompt: "0.5",
      bestScore: 0.375,
      currentPrompt: "0.5",
      currentScore: 0.375,
      currentRun: first?.run,
      history: [first],
      iteration: 1
    }])
  })

  it("converges immediately when a zero target is met", async () => {
    const options = await optionsFor()
    const result = await Effect.runPromise(Optimize.run({ ...options, initialPrompt: "0", targetScore: 0 }))
    expect(result).toMatchObject({ _tag: "Converged", bestPrompt: "0", bestScore: 0 })
    expect(result.history).toHaveLength(1)
  })

  it("returns the best on exhaustion and retains it after a regression and a tie", async () => {
    const options = await optionsFor()
    const contexts: Array<Optimize.ProposeContext> = []
    const result = await Effect.runPromise(Optimize.run({
      ...options,
      maxIterations: 3,
      targetScore: 1,
      onMaxReached: "return-best",
      propose: (context) =>
        Effect.sync(() => {
          contexts.push(context)
          return context.iteration === 1 ? "0" : "0.50"
        })
    }))
    expect(result).toMatchObject({ _tag: "Exhausted", bestPrompt: "0.5", bestScore: 0.375 })
    expect(result.bestRun).toBe(result.history[0]?.run)
    expect(result.history.map(({ score }) => score)).toEqual([0.375, 0, 0.375])
    expect(contexts.map(({ history }) => history.length)).toEqual([1, 2])
    expect(contexts[1]).toMatchObject({
      bestPrompt: "0.5",
      bestScore: 0.375,
      currentPrompt: "0",
      currentScore: 0,
      currentRun: { runId: "optimize-2" },
      iteration: 2
    })
  })

  it("uses the full budget by default when there is no target", async () => {
    const result = await Effect.runPromise(Optimize.run(await optionsFor()))
    expect(result).toMatchObject({ _tag: "Exhausted", bestPrompt: "0.5", bestScore: 0.375 })
    expect(result.history).toHaveLength(1)
  })

  it("fails on exhaustion when requested", async () => {
    const options = await optionsFor()
    const error = await Effect.runPromise(Effect.flip(Optimize.run({
      ...options,
      targetScore: 1,
      onMaxReached: "fail"
    })))
    expect(error).toMatchObject({
      code: "target_not_reached",
      message: "Best score 0.375 fell short of targetScore 1 after 1 iterations"
    })
  })

  it.each([
    ["maxIterations", 0],
    ["maxIterations", 1.5],
    ["maxIterations", Number.MAX_SAFE_INTEGER + 1],
    ["targetScore", Number.NaN],
    ["targetScore", Number.POSITIVE_INFINITY],
    ["targetScore", -0.01],
    ["targetScore", 1.01],
    ["onMaxReached", "unknown"],
    ["onMaxReached", "fail"],
    ["initialPrompt", ""],
    ["runIdPrefix", "  "]
  ])("rejects invalid %s (%s) before evaluation", async (key, value) => {
    const options = await optionsFor()
    const error = await Effect.runPromise(Effect.flip(Optimize.run({
      ...options,
      evaluatePrompt: () => {
        throw new Error("Unexpected evaluation")
      },
      [key]: value
    })))
    expect(error).toMatchObject({ code: "invalid_run_options", path: `options.${key}` })
  })

  it.each([false, true])("fails when the candidate has no scores (scorer bound: %s)", async (bound) => {
    const options = await optionsFor(bound ? [binding] : [])
    const error = await Effect.runPromise(Effect.flip(Optimize.run({
      ...options,
      initialPrompt: "unscorable",
      targetScore: 0,
      maxIterations: 2
    })))
    expect(error).toMatchObject({ code: "no_scores", message: "Iteration 1 produced no scored observations" })
  })

  it("propagates runner validation errors", async () => {
    const options = await optionsFor()
    const error = await Effect.runPromise(Effect.flip(Optimize.run({ ...options, at: "invalid" })))
    expect(error).toMatchObject({ code: "invalid_run_options", path: "options.at" })
  })

  it("provides the proposer's service and propagates its error without evaluating again", async () => {
    const options = await optionsFor()
    const Failure = Context.Service<Error>("test/Optimize/Failure")
    const failure = new Error("Proposal failed")
    const prompts: Array<string> = []
    const error = await Effect.runPromise(
      Optimize.run({
        ...options,
        maxIterations: 3,
        evaluatePrompt: (prompt) => {
          prompts.push(prompt)
          return options.evaluatePrompt(prompt)
        },
        propose: () => Effect.flatMap(Failure, Effect.fail)
      }).pipe(Effect.provideService(Failure, failure), Effect.flip)
    )
    expect(error).toBe(failure)
    expect(prompts).toEqual(["0.5"])
  })
})
