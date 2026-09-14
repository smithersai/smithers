import { expect, test } from "bun:test"
import { runHandoff } from "./RunHandoff"
import type { Card } from "../state/AppState"

test("a historical handoff does not borrow the current result, wait or acceptance", () => {
  const card: Extract<Card, { kind: "run-trace" }> = {
    id: "run-source", kind: "run-trace", title: "Retry repair", status: "active", createdAt: 0, ordinal: 0,
    payload: { repo: "owner/repo", runId: "run-1", workflow: "repair", phase: "completed", steps: [],
      result: "Current attempt passed every test", waiting: "approval", cursorSeq: 4, lastSeq: 8,
      input: { prompt: "Repair retries" } }
  }
  const text = runHandoff(card, "https://smithers.sh/w/workspace/b/main/f/source")
  expect(text).toContain("Historical evidence through event 4")
  expect(text).not.toContain("Current attempt passed")
  expect(text).not.toContain("Waiting: approval")
  expect(text).toContain("does not establish human acceptance")
  expect(text).toContain("[Open recorded run evidence](https://smithers.sh/w/workspace/b/main/f/source)")
})
