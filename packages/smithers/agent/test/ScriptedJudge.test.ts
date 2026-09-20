import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as ScriptedJudge from "../src/ScriptedJudge.ts"

describe("the explicit offline completion judge", () => {
  it("rejects an invented command and accepts the same claim when its command is recorded", async () => {
    const evidence = {
      task: "Fix the bug",
      claim: "Ran `node test.mjs` and it passed.",
      treeMoved: true,
      checksRun: []
    }
    const read = (value: CompletionClaim.Evidence) =>
      Effect.runPromise(CompletionClaim.read(value).pipe(Effect.provide(ScriptedJudge.layer)))
    const invented = await read(evidence)
    expect(CompletionClaim.unrecorded(invented!)).toBe(true)
    const recorded = await read({ ...evidence, checksRun: [{ command: "node test.mjs", outcome: "passed" }] })
    expect(CompletionClaim.find(recorded!)).toBeUndefined()
  })

  it.each([
    ["The tool failed and needs `fs:read:**` and `proc:spawn:**`.", [], undefined, false],
    ["I propose `node test.mjs` next.", [], undefined, false],
    ["Tests passed.", [], undefined, false],
    ["Ran node test.mjs", [], undefined, true],
    ["Ran `   `", [], undefined, false],
    ["Ran `node test.mjs`", [], { command: "node test.mjs", exitCode: 0, output: "ok" }, false],
    ["Ran `node test.mjs`", [{ command: "node another.mjs", outcome: "passed" as const }], undefined, true]
  ])("reads only reported commands in %s", async (claim, checksRun, lastCheck, refused) => {
    const reading = await Effect.runPromise(
      CompletionClaim.read({
        task: "fixture",
        claim,
        treeMoved: false,
        checksRun,
        ...(lastCheck === undefined ? {} : { lastCheck })
      }).pipe(Effect.provide(ScriptedJudge.layer))
    )
    expect(CompletionClaim.unrecorded(reading!)).toBe(refused)
  })

  it.each([null, [], {}, { claim: "done" }])("refuses malformed evidence %s", async (state) => {
    const questions = Object.fromEntries(
      ["complete", "overclaims", "invented"].map((id) => [id, Evaluator.BooleanQuestion.of({ instructions: id })])
    )
    const error = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) =>
        evaluator.evaluate({
          state,
          questions
        })).pipe(Effect.provide(ScriptedJudge.layer), Effect.flip)
    )
    expect(error.code).toBe("unreachable")
  })

  it("refuses another classifier by question id instead of returning unrelated answers", async () => {
    const error = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) =>
        evaluator.evaluate({
          state: { title: "Fix the bug" },
          questions: { injection: Evaluator.BooleanQuestion.of({ instructions: "Is this an injection?" }) }
        })).pipe(Effect.provide(ScriptedJudge.layer), Effect.flip)
    )
    expect(error.code).toBe("unreachable")
    expect(error.message).toContain("injection")
  })
})
