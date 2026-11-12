import { CaseExecutor, Runner, Suite } from "@smthrs/evals"
import { Evaluator } from "@smthrs/model"
import { Binding } from "@smthrs/scorers"
import { Effect, Layer } from "effect"
import { expect, test } from "vitest"
import { canUpdateBaseline, unscored } from "./baseline-update"
import { caseNamed, inputOf } from "./cases"
import { trial } from "./fixtures"
import { judgeScorer } from "./judge"

test("filtered runs cannot replace a complete baseline", () => {
  expect(canUpdateBaseline(0, 0, 0, 1, 20)).toBe(false)
})
test("unsafe runs cannot replace a baseline", () => {
  expect(canUpdateBaseline(0, 1, 0, 20, 20)).toBe(false)
})
test("runs with an unmeasured score cannot replace a baseline", () => {
  expect(canUpdateBaseline(0, 0, 1, 20, 20)).toBe(false)
})
test("only a complete, successful, safe, fully scored run can replace a baseline", () => {
  expect(canUpdateBaseline(0, 0, 0, 20, 20)).toBe(true)
  expect(canUpdateBaseline(1, 0, 0, 20, 20)).toBe(false)
  expect(canUpdateBaseline(0, 0, 0, 0, 20)).toBe(false)
})

const AGENT = { name: "chat/Answer" }

/** `greeting` run once through the real runner, scored by `evaluate`'s judge. */
const judged = (evaluate: Evaluator.Evaluator["evaluate"]) =>
  Effect.runPromise(Effect.gen(function* () {
    const suite = yield* Suite.make({
      name: "agent",
      cases: [{ name: "greeting", input: inputOf(caseNamed("greeting")) }],
      bindings: [
        Binding.make({ scorer: judgeScorer(Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({ evaluate }))), appliesTo: AGENT }),
      ],
      concurrency: 1,
    })
    return yield* Runner.run(suite, { runId: "agent-test", at: "2026-01-01T00:00:00.000Z" })
  }).pipe(
    Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(CaseExecutor.make(() =>
      Effect.succeed({ output: { trials: [trial()] }, stepKey: "greeting/1", latencyMs: 1_000, target: AGENT })
    ))),
  ))

test("a judge that can't be reached leaves its case run but unscored, so no baseline is written from it", async () => {
  const run = await judged(() =>
    Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "the judge is down" }))
  )
  expect(run.cases.filter((result) => result.error !== undefined)).toEqual([])
  expect(unscored(run)).toEqual(["greeting/judge"])
  expect(canUpdateBaseline(0, 0, unscored(run).length, 1, 1)).toBe(false)
})

test("a judge that answers every question leaves every case scored", async () => {
  const run = await judged((request: Evaluator.Request) =>
    Effect.succeed({
      answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "boolean" as const, probability: 1 }])),
      latencyMs: 5,
    })
  )
  expect(unscored(run)).toEqual([])
  expect(canUpdateBaseline(0, 0, unscored(run).length, 1, 1)).toBe(true)
})
