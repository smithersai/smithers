/**
 * The end of a run names what recorded its observed steps' reads in every renderer, and says nothing when no step
 * asked to be observed.
 */
import { expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as Audience from "../src/Audience.ts"
import type * as Executor from "../src/Executor.ts"
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

const unrecorded: Executor.Summary = {
  verb: "ci",
  pattern: "//...",
  jobs: 2,
  durationMs: 1_000,
  counts: { hit: 0, ran: 1, failed: 0, skipped: 0 },
  ok: true,
  results: [{ label: "//:test", target: "Shell.Test", status: "ran", durationMs: 10, key: "a" }]
}
const recorded: Executor.Summary = { ...unrecorded, recorder: { name: "none", why: "strace is not installed" } }
const line = "recorder: none (strace is not installed)"

it("is printed before the closing frame a person reads", () => {
  const person = Audience.resolve({ env: {}, audience: "human", stdout: true, stderr: true })
  const shown = terminal()
  Reporter.make({ renderer: "plain", terminal: shown, presentation: person }).summary(recorded)
  expect(shown.text()).toContain(line)
  expect(shown.text().indexOf(line)).toBeLessThan(shown.text().indexOf("1 targets: 0 hit, 1 ran"))
  const quiet = terminal()
  Reporter.make({ renderer: "plain", terminal: quiet, presentation: person }).summary(unrecorded)
  expect(quiet.text()).not.toContain("recorder:")
})

it("is printed under the task counts of the stream renderer", () => {
  const shown = terminal()
  Reporter.make({ renderer: "stream", terminal: shown, env: { NO_COLOR: "1" } }).summary(recorded)
  expect(shown.text()).toContain("Tasks: 1 ran, 1 total")
  expect(shown.text().indexOf(line)).toBeGreaterThan(shown.text().indexOf("Tasks: 1 ran, 1 total"))
  const quiet = terminal()
  Reporter.make({ renderer: "stream", terminal: quiet, env: { NO_COLOR: "1" } }).summary(unrecorded)
  expect(quiet.text()).not.toContain("recorder:")
})
