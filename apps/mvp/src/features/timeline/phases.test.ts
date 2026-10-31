import { SEGMENT_PROMPT } from "./steps"
import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { ARCS_FROM, SEGMENT_SPANS, SEGMENT_WINDOW } from "./contract"
import { cleanSpans, cleanSpanSummary, cleanTitle, exchangeUnits, parseMark, PHASES_FROM, phaseUnits, planOf, type PhaseRow } from "./marks"
import { segmentRevision } from "./identity"

const mark = (title: string, closed: boolean, covered: number) => JSON.stringify({ title, summary: `${title} ended.`, closed, covered })
const exchange = (n: number, extra: Partial<PhaseRow> & { readonly arc?: string } = {}, answer: Partial<PhaseRow> = {}): ReadonlyArray<PhaseRow & { readonly arc?: string }> => [
  { id: `q${n}`, role: "user", status: "done", text: `Question ${n}`, ...extra },
  { id: `a${n}`, role: "assistant", status: "done", text: `Answer ${n}`, questionId: `q${n}`, ...answer },
]
const chat = (count: number, marks: Readonly<Record<number, string>> = {}) =>
  Array.from({ length: count }, (_, n) => exchange(n, marks[n] === undefined ? {} : { phase: marks[n] })).flat()

describe("marks", () => {
  test("a stored mark reads back; anything else is no mark", () => {
    expect(parseMark(mark("Fixing tests", true, 3))).toEqual(Option.some({ title: "Fixing tests", summary: "Fixing tests ended.", closed: true, covered: 3 }))
    for (const text of ["", null, undefined, "{", '{"title":1}', "x".repeat(513)]) expect(parseMark(text)).toEqual(Option.none())
  })
})

describe("what a segmentation reads", () => {
  test("an exchange reads its question's summary and its answer's own words, and stops at the first that hasn't settled", () => {
    const units = exchangeUnits([
      ...exchange(0, { summary: "Find the bug" }, { summary: "Cause found" }),
      ...exchange(1, { text: `A ${"very ".repeat(60)}long ask` }, { status: "failed" }),
      ...exchange(2, {}, { status: "streaming" }),
      ...exchange(3),
    ])
    expect(units.map(unit => unit.id)).toEqual(["q0", "q1"])
    expect(units[0]!.text).toBe("Asked: Find the bug\nAnswered: Answer 0")
    expect(units[1]!.text).toContain("…\nAnswered: failed")
    expect(units[1]!.text.length).toBeLessThan(220)
    expect(exchangeUnits([...exchange(0, { status: "queued" })])).toEqual([])
    expect(exchangeUnits([{ id: "q", role: "user", status: "done", text: "No answer yet" }])).toEqual([])
    expect(exchangeUnits([{ id: "v", role: "view", status: "done", text: "" }, ...exchange(0)]).map(unit => unit.id)).toEqual(["q0"])
  })

  test("arcs read only closed phases", () => {
    const rows = chat(3, { 0: mark("Researching", true, 1), 1: mark("Fixing", true, 1), 2: mark("Reviewing", false, 1) })
    expect(phaseUnits(rows).map(unit => unit.text)).toEqual(["Researching: Researching ended.", "Fixing: Fixing ended."])
  })
})

describe("when a segmentation is due", () => {
  const plan = (rows: ReadonlyArray<PhaseRow>) => planOf(exchangeUnits(rows), 1)
  test("nothing until a conversation is worth it", () => {
    expect(plan(chat(PHASES_FROM - 1))).toBeUndefined()
  })
  test("a first call reads whole steps from the start, so every device names the same call", () => {
    const first = plan(chat(7))!
    expect(first).toMatchObject({ level: 1, anchorId: "q0", full: false })
    expect(first.items.map(item => item.id)).toEqual(["q0", "q1", "q2", "q3"])
    expect(first.revision).toBe(segmentRevision("q0", 1, 4))
  })
  test("an open phase waits for four new exchanges", () => {
    const open = { 0: mark("Researching", false, 4) }
    expect(plan(chat(7, open))).toBeUndefined()
    expect(plan(chat(8, open))!.items).toHaveLength(8)
  })
  test("a closed phase is never read again: the next call starts after it", () => {
    const closed = { 0: mark("Researching", true, 6), 6: mark("Fixing", false, 2) }
    expect(plan(chat(11, closed))).toBeUndefined()
    const next = plan(chat(12, closed))!
    expect(next.anchorId).toBe("q6")
    expect(next.items.map(item => item.id)).toEqual(["q6", "q7", "q8", "q9"])
    expect(plan(chat(12, { 0: mark("Researching", true, 8) }))!.anchorId).toBe("q8")
  })
  test("every open span is read again, from the first: a boundary stays a guess until enough follows it", () => {
    const open = { 0: mark("Researching", true, 4), 4: mark("Fixing", false, 2), 6: mark("Reviewing", false, 2) }
    expect(plan(chat(11, open))).toBeUndefined()
    expect(plan(chat(12, open))!.anchorId).toBe("q4")
    expect(plan(chat(12, open))!.items).toHaveLength(8)
  })
  test("a backlog is read one full window at a time, whose spans all close", () => {
    const backlog = plan(chat(200))!
    expect(backlog.items).toHaveLength(SEGMENT_WINDOW[1])
    expect(backlog.full).toBe(true)
    expect(plan(chat(200, { 0: mark("Researching", true, SEGMENT_WINDOW[1]) }))!.anchorId).toBe(`q${SEGMENT_WINDOW[1]}`)
  })
  test("arcs start once enough phases have closed", () => {
    const phases = (count: number) => chat(count, Object.fromEntries(Array.from({ length: count }, (_, n) => [n, mark(`Phase work ${n}`, true, 1)])))
    expect(planOf(phaseUnits(phases(ARCS_FROM - 1)), 2)).toBeUndefined()
    expect(planOf(phaseUnits(phases(ARCS_FROM)), 2)).toMatchObject({ level: 2, anchorId: "q0" })
  })
})

describe("what of a model's answer is stored", () => {
  const items = Array.from({ length: 8 }, (_, n) => ({ id: `q${n}`, text: `${n}` }))
  const answer = (spans: unknown) => JSON.stringify({ spans })
  const span = (from: number, title = "Fixing flaky tests") => ({ from, title, summary: "It passed on the second run." })

  test("a span closes once enough follows it, and sizes follow the spans", () => {
    const stored = cleanSpans(`Here you go:\n\`\`\`json\n${answer([span(1, "Researching issue 450"), span(4), span(7, "Reviewing PR 104")])}\n\`\`\``, { items: [...items, { id: "q8", text: "8" }], full: false })!
    expect(stored.map(({ id, mark }) => [id, JSON.parse(mark)])).toEqual([
      ["q0", { title: "Researching issue 450", summary: "It passed on the second run.", closed: true, covered: 3 }],
      ["q3", { title: "Fixing flaky tests", summary: "It passed on the second run.", closed: true, covered: 3 }],
      ["q6", { title: "Reviewing PR 104", summary: "It passed on the second run.", closed: false, covered: 3 }],
    ])
  })
  test("a full window closes its last span too", () => {
    expect(JSON.parse(cleanSpans(answer([span(1)]), { items, full: true })![0]!.mark).closed).toBe(true)
  })
  test("the first span starts at the first item, whatever the model numbered it", () => {
    expect(cleanSpans(answer([span(3)]), { items, full: false })![0]!.id).toBe("q0")
  })
  test.each([
    ["no JSON", "Sorry, I can't."], ["a broken object", "{ spans"], ["no spans", answer([])], ["too many", answer(Array.from({ length: SEGMENT_SPANS + 1 }, (_, n) => span(n + 1)))],
    ["out of order", answer([span(1), span(5), span(4)])], ["a repeat", answer([span(1), span(1)])], ["out of range", answer([span(1), span(9)])],
    ["a fraction", answer([span(1), span(2.5)])], ["a generic first title", answer([span(1, "Conversation"), span(4)])], ["no summary", answer([{ from: 1, title: "Fixing tests", summary: "" }])],
  ])("refuses %s", (_, text) => {
    expect(cleanSpans(text, { items, full: false })).toBeUndefined()
  })
  test("a later span with no usable title joins the one before it", () => {
    const stored = cleanSpans(answer([span(1), span(3, "Conversation"), span(5, "Reviewing PR 104")]), { items, full: false })!
    expect(stored.map(({ id, mark }) => [id, JSON.parse(mark).covered])).toEqual([["q0", 4], ["q4", 4]])
  })
  test("a summary of older text isn't read: the message's own words are", () => {
    const [unit] = exchangeUnits(exchange(0, { summary: "Find the login bug", summaryRevision: "stale" }))
    expect(unit!.text).toContain("Asked: Question 0")
  })
  test("titles are short plain words that name the work", () => {
    expect(cleanTitle('"Fixing flaky checkout tests."')).toBe("Fixing flaky checkout tests")
    expect(cleanTitle("Fixing the flaky checkout tests on this branch today")).toBe("Fixing the flaky checkout tests on")
    for (const value of ["", 4, "General", "Various tasks", "Phase 2", "Done", "<b>Bold</b>", `${"x".repeat(60)}`]) expect(cleanTitle(value)).toBeUndefined()
  })
  test("a long sentence is cut at a word", () => {
    const cut = cleanSpanSummary(`${"word ".repeat(60)}`)!
    expect(cut.length).toBeLessThanOrEqual(181)
    expect(cut.endsWith("word…")).toBe(true)
    expect(cleanSpanSummary(3)).toBeUndefined()
    expect(cleanSpanSummary("It <b>passed</b>.")).toBe("It bpassed/b.")
  })
})

test("the prompt names what it divides: a conversation's exchanges, or a long conversation's phases", () => {
  expect(SEGMENT_PROMPT(1)).toContain("conversation between a person and a coding agent")
  expect(SEGMENT_PROMPT(2)).toContain("long conversation's phases")
})
