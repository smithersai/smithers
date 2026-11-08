import { describe, expect, it } from "vitest"
import { runStubModel } from "../examples/stub-model.ts"

describe("examples", () => {
  it("stub-model folds the reply and prices its usage at the published rates", async () => {
    // claude-sonnet-4-5: 1,000 input tokens at $3/M plus 200 output at $15/M.
    expect(await runStubModel()).toEqual({
      content: [{ type: "text", text: "Hello" }],
      stopReason: "stop",
      cost: { costUsd: 0.006, costSource: "estimated" }
    })
  })
})
