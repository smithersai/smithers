import { expect, test } from "bun:test"
import { toolActLine } from "./ToolActLine"

test("a queued flow's act line says requested, never started", () => {
  const call = { callId: "call", name: "commands", args: JSON.stringify({ action: "execute", name: "flow.run", args: "review o/r" }) }
  expect(toolActLine(call, "run-requested workflow=review request=saved repo=o/r")).toBe("Smithers requested a review run on o/r")
  expect(toolActLine(call, "run-started workflow=review run=remote repo=o/r")).toBe("Smithers started a review run on o/r")
})
