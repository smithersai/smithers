import { describe, expect, test } from "vitest"
import { COMMITMENTS, commitmentLabel, commitmentOf, commitmentSearch, filterCommitment, hasReproCandidate, isBug } from "./lifecycle"

describe("reproduction policy", () => {
  test("recognizes bug labels and explicit titles without guessing from prose", () => {
    for (const label of ["bug", "BUG", "type: bug", "type/bug"]) expect(isBug("Crash", [label])).toBe(true)
    for (const title of ["[bug] Crash", " Bug: crash"]) expect(isBug(title, [])).toBe(true)
    expect(isBug("Fix a bug someday", ["debug"])).toBe(false)
  })
  test("requires nonempty fenced code, including a reproduction added in a comment", () => {
    for (const text of ["", "Steps: click submit", "```ts\n```", "```ts\n  \n```", "```ts\nthrow Error()", "```ts throw Error()```"])
      expect(hasReproCandidate([text])).toBe(false)
    for (const text of ["```ts\nthrow Error()\n```", "A test:\n~~~js\nassert(false)\n~~~\n", "````md\n```js\nthrow Error()\n```\n````"])
      expect(hasReproCandidate(["missing", text])).toBe(true)
  })
  test("does not turn an empty closing fence and following prose into reproduction code", () => {
    for (const text of [
      "```ts\n```\nSome prose\n```",
      "~~~\n \t\n~~~\nInstructions\n~~~",
      "```ts\n```\n```js\n```",
      "```bad`info\nassert(false)\n```",
      "````ts\nassert(false)\n```",
      "```ts\nassert(false)\n~~~",
    ]) expect(hasReproCandidate([text])).toBe(false)
    expect(hasReproCandidate([])).toBe(false)
  })
  test("reads CRLF, a longer closing fence, literal shorter fences, and a later nonempty block", () => {
    for (const text of [
      "```ts\r\nassert(false)\r\n````\r\n",
      "```ts\n\nassert(false)\n\n```",
      "````md\n```\n````",
      "~~~md\n```\n~~~",
      "```ts\n```\nProse\n~~~js\nassert(false)\n~~~",
      "\t```ts\nassert(false)\n\t```  ",
    ]) expect(hasReproCandidate([text])).toBe(true)
  })
})

describe("commitment labels", () => {
  test("derives every commitment from its GitHub label, case insensitive and duplicate safe", () => {
    for (const commitment of COMMITMENTS) {
      const label = commitmentLabel(commitment)
      expect(commitmentOf([label, label.toUpperCase(), "unrelated"])).toBe(commitment)
    }
    expect(commitmentOf([])).toBe(null)
    expect(commitmentOf(["commit-now", "smithers:commit-unknown"])).toBe(null)
  })
  test("never guesses a commitment from conflicting labels", () => {
    for (const a of COMMITMENTS) for (const b of COMMITMENTS) {
      expect(commitmentOf([commitmentLabel(a), commitmentLabel(b)])).toBe(a === b ? a : "conflict")
    }
  })
})

test("commitment filters validate URL state and retain only matching rows", () => {
  const rows = [{ commitment: "now" }, { commitment: "later" }, { commitment: null }, {}]
  expect(filterCommitment(rows)).toBe(rows)
  for (const commitment of COMMITMENTS) expect(commitmentSearch({ commitment })).toEqual({ commitment })
  for (const commitment of ["", "wrong", null, 1]) expect(commitmentSearch({ commitment })).toEqual({})
  expect(commitmentSearch({})).toEqual({})
  expect(filterCommitment(rows, "now")).toEqual([{ commitment: "now" }])
})


test("No commitment includes unlabeled and explicitly uncommitted issues", () => {
  const rows = [{ commitment: "" }, { commitment: null }, {}, { commitment: "none" }, { commitment: "now" }, { commitment: "conflict" }]
  expect(filterCommitment(rows, "none")).toEqual(rows.slice(0, 4))
})
