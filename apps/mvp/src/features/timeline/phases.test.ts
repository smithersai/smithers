import { SEGMENT_PROMPT } from "./steps"
import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { ARCS_FROM, SEGMENT_SPANS, SEGMENT_WINDOW } from "./contract"
import { checkPlan, cleanSpans, cleanSpanSummary, cleanTitle, exchangeUnits, parseMark, PHASES_FROM, phaseUnits, planOf, readOf, sealSpans, type PhaseRow } from "./marks"
import { segmentRevision } from "./identity"
import { SegmentPayload } from "./flow"

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
  test.each([-1, 0, 1.5, 100_001, 1e300, Number.MAX_SAFE_INTEGER])("a mark covering %s items is no mark, so stored rows can't break anyone's plan", covered => {
    expect(parseMark(mark("Fixing tests", true, covered))).toEqual(Option.none())
    expect(planOf(exchangeUnits(chat(8, { 0: mark("Fixing tests", true, covered) })), 1)?.anchorId).toBe("q0")
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
  test("a backlog starts with bounded input", () => {
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

describe("what the server takes of a segmentation", () => {
  const units = (rows: ReadonlyArray<PhaseRow>) => exchangeUnits(rows)
  test("the next call passes, and it reads the server's own items", () => {
    expect(checkPlan(units(chat(9)), "q0", 8)).toEqual(["q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"])
    expect(checkPlan(units(chat(12, { 0: mark("Researching", true, 4), 4: mark("Fixing", false, 4) })), "q4", 8)).toEqual(["q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11"])
  })
  test("a rolling plan stands for every item its summaries hold, whatever its input window", () => {
    const rows = chat(40, { 0: mark("Researching", false, 24) })
    const plan = planOf(units(rows), 1)!
    expect(plan.items[0]).toMatchObject({ id: "q0", covered: 24 })
    const ids = checkPlan(units(rows), plan.anchorId, readOf(plan.items)) as ReadonlyArray<string>
    expect(ids).toHaveLength(readOf(plan.items))
    expect(plan.revision).toBe(segmentRevision("q0", 1, ids.length))
  })
  test.each([
    ["inside a closed span", { 0: mark("Researching", true, 4) }, "q2", 4, "closed"],
    ["at a closed span", { 0: mark("Researching", true, 4) }, "q0", 4, "closed"],
    ["past the next start", {}, "q2", 4, "stale"],
    ["a stranger", {}, "gone", 4, "stale"],
    ["past the conversation's end", {}, "q0", 16, "stale"],
    ["no newer than what is stored", { 0: mark("Researching", false, 8) }, "q0", 8, "stale"],
    ["older than what is stored", { 0: mark("Researching", false, 8) }, "q0", 4, "stale"],
  ] as const)("refuses a call %s", (_, marks, anchor, read, refusal) => {
    expect(checkPlan(units(chat(12, marks)), anchor, read)).toBe(refusal)
  })
  const ids = ["q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]
  const span = (id: string, title = "Fixing flaky tests") => ({ id, title, summary: "It passed." })
  test("coverage and closing come from the boundaries, never a device", () => {
    const sealed = sealSpans([span("q0"), span("q3"), span("q6")], ids)!
    expect(sealed.map(({ id, mark }) => [id, JSON.parse(mark).closed, JSON.parse(mark).covered])).toEqual([["q0", true, 3], ["q3", true, 3], ["q6", false, 3]])
    expect(JSON.parse(sealSpans([span("q0")], ids)![0]!.mark)).toMatchObject({ closed: false, covered: 9 })
  })
  test.each([
    ["no first item", [span("q1")]], ["a repeat", [span("q0"), span("q0")]], ["out of order", [span("q0"), span("q4"), span("q2")]],
    ["a stranger", [span("q0"), span("nope")]], ["a generic title", [span("q0", "Conversation")]], ["markup", [{ id: "q0", title: "Fixing tests", summary: "<b>x</b>" }]],
  ])("refuses %s", (_, spans) => {
    expect(sealSpans(spans, ids)).toBeUndefined()
  })
})

describe("what of a model's answer is stored", () => {
  const items = Array.from({ length: 8 }, (_, n) => ({ id: `q${n}`, text: `${n}` }))
  const answer = (spans: unknown) => JSON.stringify({ spans })
  const span = (from: number, title = "Fixing flaky tests") => ({ from, title, summary: "It passed on the second run." })

  test("spans read out of a model's wrapping, with the items they start at", () => {
    const stored = cleanSpans(`Here you go:\n\`\`\`json\n${answer([span(1, "Researching issue 450"), span(4), span(7, "Reviewing PR 104")])}\n\`\`\``, { items })!
    expect(stored).toEqual([
      { id: "q0", title: "Researching issue 450", summary: "It passed on the second run." },
      { id: "q3", title: "Fixing flaky tests", summary: "It passed on the second run." },
      { id: "q6", title: "Reviewing PR 104", summary: "It passed on the second run." },
    ])
  })
  test("a full input window leaves an uninterrupted goal open", () => {
    expect(JSON.parse(sealSpans(cleanSpans(answer([span(1)]), { items })!, items.map(item => item.id))![0]!.mark).closed).toBe(false)
  })
  test("the first span starts at the first item, whatever the model numbered it", () => {
    expect(cleanSpans(answer([span(3)]), { items })![0]!.id).toBe("q0")
  })
  test.each([
    ["no JSON", "Sorry, I can't."], ["a broken object", "{ spans"], ["no spans", answer([])], ["too many", answer(Array.from({ length: SEGMENT_SPANS + 1 }, (_, n) => span(n + 1)))],
    ["out of order", answer([span(1), span(5), span(4)])], ["a repeat", answer([span(1), span(1)])], ["out of range", answer([span(1), span(9)])],
    ["a fraction", answer([span(1), span(2.5)])], ["a generic first title", answer([span(1, "Conversation"), span(4)])], ["no summary", answer([{ from: 1, title: "Fixing tests", summary: "" }])],
  ])("refuses %s", (_, text) => {
    expect(cleanSpans(text, { items })).toBeUndefined()
  })
  test("a later span with no usable title joins the one before it", () => {
    const stored = cleanSpans(answer([span(1), span(3, "Conversation"), span(5, "Reviewing PR 104")]), { items })!
    expect(stored.map(({ id }) => id)).toEqual(["q0", "q4"])
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
    expect(cleanSpanSummary("x".repeat(400))).toHaveLength(180)
    expect(cleanSpanSummary("It <b>passed</b>.")).toBe("It bpassed/b.")
  })
})

test("the prompt names what it divides: a conversation's exchanges, or a long conversation's phases", () => {
  expect(SEGMENT_PROMPT(1)).toContain("conversation between a person and a coding agent")
  expect(SEGMENT_PROMPT(2)).toContain("long conversation's phases")
})


describe("rolling phase input", () => {
  test.each([1, 2] as const)("a level %s goal stays open across repeated full windows and resume", level => {
    const size = SEGMENT_WINDOW[level]
    const units = (count: number, stored: ReadonlyArray<{ id: string; mark: string }> = []) => Array.from({ length: count }, (_, n) => ({
      id: `q${n}`, text: `Same checkout goal ${n}`, mark: parseMark(stored.find(row => row.id === `q${n}`)?.mark),
    }))
    let stored: ReadonlyArray<{ id: string; mark: string }> = []
    const snapshots = [size, size + 12, size + 36, size + 80]
    for (const count of snapshots) {
      // As sync records each batch, a backlog advances using the persisted summary, never by closing the goal.
      for (let calls = 0; calls < count; calls++) {
        const plan = planOf(units(count, stored), level)
        if (plan === undefined) break
        expect(plan.anchorId).toBe("q0")
        expect(plan.items.length).toBeLessThanOrEqual(size)
        if (stored.length) {
          expect(plan.items[0]!.text).toContain("The checkout fix is still being tested")
          expect(plan.items[0]!.covered).toBeGreaterThan(1)
        }
        const sent = cleanSpans(JSON.stringify({ spans: [{ from: 1, title: "Fixing checkout validation", summary: "The checkout fix is still being tested" }] }), plan)!
        stored = sealSpans(sent, checkPlan(units(count, stored), plan.anchorId, readOf(plan.items)) as ReadonlyArray<string>)!
        expect(stored).toHaveLength(1)
        expect(JSON.parse(stored[0]!.mark).closed).toBe(false)
      }
      const covered = JSON.parse(stored[0]!.mark).covered
      expect(covered).toBeGreaterThanOrEqual(count - (level === 1 ? 3 : 5))
      expect(covered).toBeLessThanOrEqual(count)
      // A fresh device has no in-memory accumulator: the mark is the entire rolling checkpoint.
      expect(planOf(units(count, JSON.parse(JSON.stringify(stored))), level)).toBeUndefined()
    }
  })

  test("a persisted closed span keeps older provisional marks out of the next rolling checkpoint", () => {
    const rows = chat(12, { 0: mark("Earlier provisional goal", false, 2), 2: mark("Completed checkout fix", true, 4), 6: mark("Writing release notes", false, 2) })
    expect(planOf(exchangeUnits(rows), 1)!.anchorId).toBe("q6")
  })

  test("a real transition after the rolling prefix closes only the earlier goal, at its actual exchange", () => {
    const rows = chat(28, { 0: mark("Fixing checkout validation", false, 24) })
    const plan = planOf(exchangeUnits(rows), 1)!
    expect(plan.items.map(item => item.id)).toEqual(["q0", "q24", "q25", "q26", "q27"])
    expect(plan.revision).toBe(segmentRevision("q0", 1, 28))
    const sent = cleanSpans(JSON.stringify({ spans: [
      { from: 1, title: "Fixing checkout validation", summary: "Validation passed" },
      { from: 2, title: "Writing release notes", summary: "Release notes drafted" },
    ] }), plan)!
    const spans = sealSpans(sent, checkPlan(exchangeUnits(rows), plan.anchorId, readOf(plan.items)) as ReadonlyArray<string>)!
    expect(spans.map(row => [row.id, JSON.parse(row.mark).covered, JSON.parse(row.mark).closed])).toEqual([["q0", 24, true], ["q24", 4, false]])
    expect(planOf(exchangeUnits(chat(32, Object.fromEntries(spans.map(row => [Number(row.id.slice(1)), row.mark])))), 1)!.anchorId).toBe("q24")
  })
})


test("durable phase payloads keep rolling weights and still decode older unweighted plans", () => {
  const decode = Schema.decodeUnknownSync(Schema.Struct(SegmentPayload))
  const legacy = planOf(exchangeUnits(chat(8)), 1)!
  expect(decode(legacy).items[0]).not.toHaveProperty("covered")
  const rolling = planOf(exchangeUnits(chat(28, { 0: mark("Fixing checkout validation", false, 24) })), 1)!
  expect(decode(rolling).items[0]?.covered).toBe(24)
  for (const covered of [0, -1, 1.5, Infinity, NaN]) {
    expect(() => decode({ ...rolling, items: [{ ...rolling.items[0], covered }, ...rolling.items.slice(1)] })).toThrow()
  }
})
