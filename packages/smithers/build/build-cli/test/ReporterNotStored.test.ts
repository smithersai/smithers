/**
 * The end of a run counts the green results it did not store, by reason, in
 * every renderer, and says nothing when it stored them all.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as Audience from "../src/Audience.ts"
import * as Executor from "../src/Executor.ts"
import * as Reporter from "../src/Reporter.ts"

const terminal = (): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY: true,
    columns: 120,
    text: () => Ansi.strip(out)
  }
}

const changed = "an installed tree changed after it was planned"

const stored: Executor.Summary = {
  verb: "ci",
  pattern: "//...",
  jobs: 2,
  durationMs: 1_000,
  counts: { hit: 0, ran: 3, failed: 0, skipped: 0 },
  ok: true,
  results: [
    { label: "//:lint", target: "EsLint", status: "ran", durationMs: 10, key: "a", notStored: changed },
    { label: "//:check", target: "Typecheck", status: "ran", durationMs: 10, key: "b", notStored: changed },
    { label: "//:fmt", target: "Dprint", status: "ran", durationMs: 10, key: "c" }
  ]
}
const unstored: Executor.Summary = {
  ...stored,
  notStored: [{ reason: changed, count: 2 }, { reason: "Dprint results are not reused", count: 1 }]
}
const line = `3 results not stored: 2 ${changed}; 1 Dprint results are not reused`

describe("the count of results not stored", () => {
  it("puts the most common reason first, and equal counts in reason order", () => {
    expect(Executor.notStoredCounts(["b", "c", "a", "c", "b", "c"])).toEqual([
      { reason: "c", count: 3 },
      { reason: "b", count: 2 },
      { reason: "a", count: 1 }
    ])
    expect(Executor.notStoredCounts(["b", "a"])).toEqual([{ reason: "a", count: 1 }, { reason: "b", count: 1 }])
    expect(Executor.notStoredCounts([])).toEqual([])
  })

  it("is one line naming each reason, and nothing when every result was stored", () => {
    expect(Reporter.notStoredSummary(unstored)).toBe(line)
    expect(Reporter.notStoredSummary({ ...stored, notStored: [{ reason: changed, count: 1 }] })).toBe(
      `1 result not stored: 1 ${changed}`
    )
    expect(Reporter.notStoredSummary(stored)).toBeUndefined()
    expect(Reporter.notStoredSummary({ ...stored, notStored: [] })).toBeUndefined()
  })
})

describe("each renderer", () => {
  it("prints the line after the plain summary", () => {
    const lines: Array<string> = []
    const reporter = Reporter.plain((text) => lines.push(text))
    reporter.summary(unstored)
    reporter.summary(stored)
    expect(lines).toEqual(["3 targets: 0 hit, 3 ran, 0 failed, 0 skipped (1.0s)", line, lines[0]])
  })

  it("prints the line before the closing frame a person reads", () => {
    const person = Audience.resolve({ env: {}, audience: "human", stdout: true, stderr: true })
    const shown = terminal()
    Reporter.make({ renderer: "plain", terminal: shown, presentation: person }).summary(unstored)
    expect(shown.text()).toContain(line)
    expect(shown.text().indexOf(line)).toBeLessThan(shown.text().indexOf("3 targets: 0 hit, 3 ran"))
    const quiet = terminal()
    Reporter.make({ renderer: "plain", terminal: quiet, presentation: person }).summary(stored)
    expect(quiet.text()).toContain("3 targets: 0 hit, 3 ran")
    expect(quiet.text()).not.toContain("not stored")
  })

  it("prints the line under the task counts of the stream renderer", () => {
    const shown = terminal()
    Reporter.make({ renderer: "stream", terminal: shown, env: { NO_COLOR: "1" } }).summary(unstored)
    expect(shown.text()).toContain("Tasks: 3 ran, 3 total")
    expect(shown.text()).toContain(line)
    const quiet = terminal()
    Reporter.make({ renderer: "stream", terminal: quiet, env: { NO_COLOR: "1" } }).summary(stored)
    expect(quiet.text()).not.toContain("not stored")
  })
})
