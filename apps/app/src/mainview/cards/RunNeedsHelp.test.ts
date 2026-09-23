import { describe, expect, test } from "bun:test"
import { latestNeedsHelp, NEEDS_HELP_LABELS } from "./RunNeedsHelp"

const settled = (sequence: number, needsHelp: unknown, frame = sequence) => ({
  sequence,
  kind: "control.agent.supervisor-settled",
  occurredAt: sequence,
  payload: { scope: "run-1", frame, needsHelp }
})

const unjudged = (sequence: number) => ({
  sequence,
  kind: "control.agent.supervisor-unjudged",
  occurredAt: sequence,
  payload: { scope: "run-1", frame: sequence, reason: "interrupted", detail: "deadline" }
})

describe("latestNeedsHelp", () => {
  test("no supervisor reading derives nothing", () => {
    expect(latestNeedsHelp([])).toBeUndefined()
    expect(latestNeedsHelp([
      { sequence: 1, kind: "control.agent.turn-opened", payload: { seat: "openai:gpt-5.6-sol" } }
    ])).toBeUndefined()
    /* Unjudged alone is not a reading: never "fine", never a guess. */
    expect(latestNeedsHelp([unjudged(1)])).toBeUndefined()
  })

  test("a newer settled reading replaces an older one", () => {
    expect(latestNeedsHelp([settled(1, "stuck"), settled(2, "permission")])).toBe("permission")
    expect(latestNeedsHelp([settled(1, "permission"), settled(2, "none")])).toBe("none")
  })

  test("sequence, not array position, decides which reading is newer", () => {
    expect(latestNeedsHelp([settled(2, "permission"), settled(1, "stuck")])).toBe("permission")
  })

  test("an unjudged reading never clears the last judged word", () => {
    expect(latestNeedsHelp([settled(1, "stuck"), unjudged(2)])).toBe("stuck")
    expect(latestNeedsHelp([unjudged(1), settled(2, "risky_action"), unjudged(3)])).toBe("risky_action")
  })

  test("a payload without a known word is skipped, not guessed", () => {
    expect(latestNeedsHelp([settled(1, "stuck"), settled(2, undefined)])).toBe("stuck")
    expect(latestNeedsHelp([settled(1, "fine")])).toBeUndefined()
    expect(latestNeedsHelp([{ sequence: 1, kind: "control.agent.supervisor-settled", payload: null }])).toBeUndefined()
  })

  test("every non-none value has exactly one label", () => {
    expect(NEEDS_HELP_LABELS).toEqual({
      clarification: "Needs clarification",
      permission: "Needs permission",
      stuck: "Stuck",
      risky_action: "Risky action"
    })
  })
})
