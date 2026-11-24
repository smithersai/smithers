import { Fuzz } from "@smthrs/fuzz"
import * as Binding from "@smthrs/scorers/Binding"
import * as Scorer from "@smthrs/scorers/Scorer"
import { ScorerError } from "@smthrs/scorers/ScorerError"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CaseExecutor from "../src/CaseExecutor.ts"
import * as Optimize from "../src/Optimize.ts"
import * as Suite from "../src/Suite.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261132")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const target = { name: "target" }
const numericScorer = Scorer.make({
  id: "packages/smithers/agent/evals/test/EvalsWave7Optimize/numeric",
  name: "numeric",
  version: "1",
  score: ({ output, input }) =>
    input === "unscorable"
      ? Effect.fail(new ScorerError({ code: "inconclusive", message: "No reference score" }))
      : Effect.succeed({ score: Math.min(1, Math.max(0, Number(output) * Number(input))) })
})
const numericBinding = Binding.make({ scorer: numericScorer, appliesTo: target })

describe("@smthrs/evals Wave 7 deep fuzz (Optimize.run + meanScore + all option/convergence/exhaustion/no-scores boundaries)", () => {
  it(
    "Optimize.run enforces option validation, tie-breaking, convergence, exhaustion policies, and no-scores refusal",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "converge",
            "exhaustReturnBest",
            "exhaustFail",
            "noScores",
            "badMaxIter",
            "badTarget",
            "badPolicy",
            "failWithoutTarget",
            "emptyPrompt",
            "emptyPrefix",
            "tieBreaking"
          ]),
          maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
          baseScore: Schema.Literals([0.2, 0.5, 0.8])
        })
      )

      const suite = await Effect.runPromise(
        Suite.make({
          name: "opt-suite",
          concurrency: 1,
          bindings: [numericBinding],
          cases: [
            { name: "full", input: 1 },
            { name: "half", input: 0.5 },
            { name: "unscorable", input: "unscorable" }
          ]
        })
      )
      const noScoreSuite = await Effect.runPromise(
        Suite.make({
          name: "noscore-suite",
          concurrency: 1,
          bindings: [],
          cases: [{ name: "c1", input: 1 }]
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, maxIterations, baseScore }) =>
            Effect.gen(function*() {
              const evalPrompt = (prompt: string) =>
                CaseExecutor.make((suiteCase) =>
                  Effect.succeed({
                    output: prompt,
                    stepKey: suiteCase.name,
                    latencyMs: 0,
                    target
                  })
                )

              const initialPrompt = mode === "emptyPrompt"
                ? "   "
                : mode === "tieBreaking"
                ? "0.6"
                : mode === "converge"
                ? String(baseScore)
                : String(Math.min(0.4, baseScore * 0.4))

              const ex = yield* Optimize.run({
                suite: mode === "noScores" ? noScoreSuite : suite,
                initialPrompt,
                evaluatePrompt: evalPrompt,
                propose: (ctx) =>
                  Effect.succeed(
                    mode === "tieBreaking"
                      ? "0.6"
                      : mode === "converge"
                      ? String(Math.min(1, Number(ctx.currentPrompt) + 0.3))
                      : ctx.currentPrompt
                  ),
                maxIterations: mode === "badMaxIter" ? 0 : maxIterations,
                targetScore: mode === "badTarget"
                  ? 1.5
                  : mode === "failWithoutTarget"
                  ? undefined
                  : mode === "converge"
                  ? 0.5
                  : mode === "exhaustFail"
                  ? 0.99
                  : undefined,
                onMaxReached: mode === "badPolicy"
                  ? ("bogus" as never)
                  : mode === "exhaustFail" || mode === "failWithoutTarget"
                  ? "fail"
                  : "return-best",
                runIdPrefix: mode === "emptyPrefix" ? "  " : "opt",
                at: "2026-11-24T00:00:00.000Z"
              }).pipe(Effect.exit)

              if (
                mode === "noScores" ||
                mode === "badMaxIter" ||
                mode === "badTarget" ||
                mode === "badPolicy" ||
                mode === "failWithoutTarget" ||
                mode === "emptyPrompt" ||
                mode === "emptyPrefix" ||
                mode === "exhaustFail"
              ) {
                expect(Exit.isFailure(ex)).toBe(true)
              } else {
                expect(Exit.isSuccess(ex)).toBe(true)
                if (Exit.isSuccess(ex)) {
                  expect(ex.value.history.length).toBeGreaterThan(0)
                  expect(ex.value.history.length).toBeLessThanOrEqual(maxIterations)
                  if (mode === "tieBreaking") {
                    expect(ex.value.bestPrompt).toBe("0.6")
                  }
                }
              }
              return true
            }),
          { executions: Math.min(executions, 90), seed }
        )
      )
      assertPassed(report)
    },
    30_000
  )
})
