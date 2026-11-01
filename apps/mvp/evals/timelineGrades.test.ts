import { expect, test } from "vitest"
import { GATES, gateFailures, phaseExchanges } from "./timelineGrades"

const exchanges = [["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"]] as const

test("each phase is judged on the exchanges it spans: to the next phase's start, the last to the conversation's end", () => {
  const spans = phaseExchanges([{ from: 0, title: "One", summary: "x" }, { from: 2, title: "Two", summary: "y" }], exchanges)
  expect(spans.map(span => span.exchanges.map(exchange => exchange.n))).toEqual([[0, 1], [2, 3]])
  expect(spans[1]).toMatchObject({ title: "Two", summary: "y", exchanges: [{ n: 2, question: "c", answer: "C" }, { n: 3, question: "d", answer: "D" }] })
})

test("a fixture fails every absolute gate it is under, by name, and a missing score counts as zero", () => {
  const passing = Object.fromEntries(Object.entries(GATES).map(([name, gate]) => [name, gate]))
  expect(gateFailures("chat", passing)).toEqual([])
  expect(gateFailures("chat", { ...passing, faithful: 0.383 })).toEqual([`chat: faithful 0.383 < ${GATES.faithful}`])
  const { titles: _, ...missing } = passing
  expect(gateFailures("chat", missing)).toEqual([`chat: titles 0.000 < ${GATES.titles}`])
})

test("faithfulness is gated at 0.8 or more, never relative to a recorded baseline", () => {
  expect(GATES.faithful).toBeGreaterThanOrEqual(0.8)
  expect(GATES.entryAccurate).toBeGreaterThanOrEqual(0.8)
})
