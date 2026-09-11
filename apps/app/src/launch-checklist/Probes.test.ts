/*
 * The measuring instruments the rows share. Each one turns a checklist
 * sentence into something a rendered page can be measured against, so each one
 * is pinned here.
 */
import { describe, expect, test } from "bun:test"
import {
  countOccurrences,
  countQuestions,
  RATING_COPY,
  replyRegion,
  SCORE_COPY,
  SETUP_COPY,
  unnamedAffordances,
  waitForText,
  ZERO_BALANCE_PAUSE_COPY
} from "./Probes.ts"
import type { ProbePage } from "./Types.ts"

const pageWithTexts = (texts: ReadonlyArray<string>): ProbePage => {
  let index = 0
  return {
    text: async () => texts[Math.min(index++, texts.length - 1)] ?? "",
    evaluate: async () => undefined as never,
    type: async () => {},
    press: async () => {},
    reload: async () => {}
  }
}

describe("countOccurrences", () => {
  test("counts non-overlapping statements", () => {
    expect(countOccurrences("a $500 line and a $500 line", "$500 line")).toBe(2)
    expect(countOccurrences("nothing here", "$500 line")).toBe(0)
    expect(countOccurrences("aaa", "")).toBe(0)
  })
})

describe("replyRegion", () => {
  test("is the text that arrived after the prompt was sent", () => {
    expect(replyRegion("before", "beforeafter")).toBe("after")
  })

  test("falls back to the whole transcript when the page rewrote it", () => {
    expect(replyRegion("before", "different")).toBe("different")
  })
})

describe("countQuestions", () => {
  test("counts the lines that actually ask something", () => {
    expect(countQuestions("Which repo?\nI will start there.\nShall I?")).toBe(2)
    expect(countQuestions("No questions here.")).toBe(0)
  })
})

describe("unnamedAffordances", () => {
  test("names both the affordances with no command and the ones the registry does not know", () => {
    expect(
      unnamedAffordances(
        [
          { label: "Accept", flow: "flow.run" },
          { label: "Mystery", flow: null },
          { label: "Ghost", flow: "flow.ghost" }
        ],
        ["flow.run"]
      )
    ).toEqual(["Mystery → no data-flow", "Ghost → flow.ghost"])
  })
})

describe("waitForText", () => {
  test("returns as soon as the predicate holds", async () => {
    let clock = 0
    const found = await waitForText(
      pageWithTexts(["waiting", "arrived"]),
      (text) => text === "arrived",
      10_000,
      () => (clock += 100),
      async () => {}
    )
    expect(found.ok).toBe(true)
  })

  test("gives up at the budget instead of hanging a post-deploy re-run", async () => {
    let clock = 0
    const found = await waitForText(
      pageWithTexts(["waiting"]),
      (text) => text === "arrived",
      1_000,
      () => (clock += 600),
      async () => {}
    )
    expect(found.ok).toBe(false)
    expect(found.elapsedMs).toBeGreaterThanOrEqual(1_000)
  })
})

describe("the copy bars", () => {
  test("catch the states the checklist calls failures", () => {
    expect(SETUP_COPY.test("Run git clone to get started")).toBe(true)
    expect(SETUP_COPY.test("Your workspace is already here.")).toBe(false)
    expect(RATING_COPY.test("Was this helpful?")).toBe(true)
    expect(SCORE_COPY.test("Confidence: 8/10")).toBe(true)
    expect(SCORE_COPY.test("Opened pull request 12 in will/flows")).toBe(false)
  })

  test("recognise the zero-balance pause statement the client dispatches", () => {
    expect(
      ZERO_BALANCE_PAUSE_COPY.test(
        "Balance is at $0 — workflow runs pause until more balance is added. Run /billing.upgrade to add balance; chat stays free in the meantime."
      )
    ).toBe(true)
  })
})
