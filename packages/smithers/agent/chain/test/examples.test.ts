import { describe, expect, it } from "vitest"
import { runAChain } from "../examples/run-a-chain.vibe"

describe("examples", () => {
  it("run-a-chain finishes with the matched count", async () => {
    expect(await runAChain()).toEqual({ _tag: "Done", value: { matched: 2 } })
  })
})
