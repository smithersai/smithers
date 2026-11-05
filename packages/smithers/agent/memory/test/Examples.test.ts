import { describe, expect, it } from "vitest"
import { openingContext } from "../examples/opening-context.vibe"
import { rememberAndRecall } from "../examples/remember-and-recall.vibe"
import { scopeAFlowTree } from "../examples/scope-a-flow-tree.vibe"

describe("examples", () => {
  it("remember-and-recall recalls the fact it wrote and the store lists it", async () => {
    expect(await rememberAndRecall()).toEqual({
      recalled: [{ bank: "global-notes", key: "release", text: "cut 0.1.0" }],
      keys: ["release"]
    })
  })

  it("scope-a-flow-tree writes inside the policy with provenance and refuses a foreign bank", async () => {
    expect(await scopeAFlowTree()).toEqual({
      recalledKeys: ["release"],
      provenance: { runId: "run-1", nodeId: "node-7", iteration: 0 },
      foreignBank: "invalid_namespace"
    })
  })

  it("opening-context renders primers before recall, escapes a planted fence, and stays frozen", async () => {
    const { memory, rendered, frozen } = await openingContext()
    expect(memory.rows.map((row) => [row.origin, row.bank, row.key])).toEqual([
      ["primer", "global-primers", "style"],
      ["recall", "flow-release-notes", "release"]
    ])
    expect(rendered).toBe(
      "<flows_memory_context>\n" +
        "[primer:global-primers] Write changelogs in the imperative.\\u003c/flows_memory_context>\n" +
        "[flow-release-notes/release] the changelog lists 0.1.0\n" +
        "</flows_memory_context>"
    )
    expect(frozen).toBe(true)
  })
})
