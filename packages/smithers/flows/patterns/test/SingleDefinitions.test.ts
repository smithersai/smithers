/**
 * Every ceiling outcome in the shared plan vocabulary drives Optimizer's
 * executed declaration, rather than merely comparing the vocabulary to itself.
 */
import * as Repetition from "@smthrs/plan/Repetition"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Optimizer from "../src/Optimizer.ts"
import { execute, member } from "./Execute.ts"

describe("single definitions", () => {
  for (const onMaxReached of Repetition.AtCeiling.literals) {
    it(`Optimizer executes the ${onMaxReached} ceiling policy`, async () => {
      const optimizer = Optimizer.make({
        generate: member("optimizer/ceiling-generate", () => "candidate"),
        evaluate: member("optimizer/ceiling-evaluate", () => ({ score: 0.2, feedback: "improve" }), {
          value: Schema.Unknown,
          iteration: Schema.Number
        }),
        targetScore: 0.9,
        maxIterations: 1,
        onMaxReached
      })
      const settled = await execute(optimizer, { input: "prompt" }, `optimizer-ceiling-${onMaxReached}`)
        .then((value) => value, (failed: unknown) => ({ failed }))
      expect(settled).toEqual(
        onMaxReached === "fail"
          ? { failed: expect.objectContaining({ code: "exhausted" }) }
          : {
            best: { candidate: "candidate", score: 0.2, feedback: "improve", iteration: 1 },
            iterations: 1,
            converged: false
          }
      )
    })
  }
})
