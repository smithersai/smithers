/**
 * The print channel: budget sharing, honest notices, and compact structures.
 *
 * The cases here are the unit half of what `ReplRealm.test.ts` proves through a
 * real realm. They fix the two properties the r95repl lane says the channel was
 * missing — one long statement may spend the whole frame budget, and what it
 * loses is the middle rather than the tail — and the one property the change may
 * not break: a frame never delivers more than `Sandbox.printFrameBytes`.
 *
 * @since 0.1.0
 */
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type { Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as bytes from "../src/internal/bytes.ts"
import * as elide from "../src/internal/elide.ts"
import * as printChannel from "../src/internal/printChannel.ts"
import * as Sandbox from "../src/Sandbox.ts"

const statement = (text: string): printChannel.Statement => ({ text, bytes: bytes.size(text) })

const record = (file: string, line: number, text: string) => ({ file, line, text })

describe("printChannel budgets", () => {
  it("owns the numbers it spends rather than importing them back from the port", () => {
    // The port is the public module; an internal one that reads its own
    // ceilings off it points the dependency the wrong way round.
    const source = readFileSync(new URL("../src/internal/printChannel.ts", import.meta.url), "utf8")
    expect(source).not.toContain("../Sandbox.ts")
    // A host still reads one number: the port re-exports what the channel owns.
    expect(Sandbox.printFrameBytes).toBe(printChannel.printFrameBytes)
    expect(Sandbox.printStatementFloor).toBe(printChannel.printStatementFloor)
    expect(Sandbox.printRetainedBytes).toBe(printChannel.printRetainedBytes)
  })
})

describe("printChannel.shares", () => {
  it("gives every statement what it needs when the budget covers them all", () => {
    expect(printChannel.shares([10, 20, 30], 1000)).toEqual([10, 20, 30])
  })

  it("hands a short statement's remainder to the long one", () => {
    // The whole point: 100 spent on the two short values leaves the rest for the
    // one that would otherwise have been cut to a quarter of the budget.
    expect(printChannel.shares([10, 4000, 20], 1000)).toEqual([10, 970, 20])
  })

  it("splits a budget no statement fits into evenly, oldest first on a tie", () => {
    expect(printChannel.shares([4000, 4000, 4000], 999)).toEqual([333, 333, 333])
  })

  it("apportions nothing across nothing", () => {
    expect(printChannel.shares([], 1000)).toEqual([])
  })
})

describe("printChannel.buffer", () => {
  it("is empty for a frame that printed nothing and lost nothing", () => {
    expect(printChannel.buffer([], 0)).toBe("")
  })

  it("leaves short statements exactly as they were", () => {
    expect(printChannel.buffer([statement("first"), statement("second")], 0)).toBe("first\nsecond")
  })

  it("elides one long statement from the middle and names the whole size", () => {
    const text = `HEAD${"x".repeat(Sandbox.printFrameBytes * 3)}TAIL`
    const out = printChannel.buffer([statement(text)], 0)
    expect(out.startsWith("HEAD")).toBe(true)
    expect(out.endsWith("TAIL")).toBe(true)
    expect(out).toContain(`of ${text.length} bytes elided from the middle`)
    expect(out).toContain(printChannel.recall)
  })

  it("never delivers more than one frame's budget", () => {
    for (
      const frame of [
        [statement("x".repeat(200_000))],
        Array.from({ length: 12 }, () => statement("y".repeat(4_095))),
        Array.from({ length: 400 }, (_, index) => statement(`line ${index} ${"z".repeat(index)}`))
      ]
    ) {
      expect(bytes.size(printChannel.buffer(frame, 0))).toBeLessThanOrEqual(Sandbox.printFrameBytes)
    }
  })

  it("keeps every statement of a frame whose statements all fit", () => {
    // The regression a fixed count of 32 caused: two hundred short lines were
    // cut to thirty-two while fifteen of the frame's sixteen kilobytes went
    // unspent, which is the failure the shared budget exists to end.
    const frame = Array.from({ length: 200 }, (_, index) => statement(`line ${index}`))
    const out = printChannel.buffer(frame, 0)
    expect(out.split("\n")).toHaveLength(200)
    expect(out).toContain("line 100")
    expect(out).not.toContain("elided")
    expect(bytes.size(out)).toBeLessThanOrEqual(Sandbox.printFrameBytes)
  })

  it("shows a statement at or under the statement floor whole, however many there are", () => {
    const frame = Array.from({ length: 5_000 }, () => statement("z".repeat(Sandbox.printStatementFloor)))
    const out = printChannel.buffer(frame, 0)
    expect(out).toContain("print statements elided from the middle of this frame")
    // Whole statements went; the ones that stayed were not shortened, because a
    // statement the floor covers is never worth replacing with a notice.
    expect(out).not.toContain("bytes elided from the middle")
    expect(bytes.size(out)).toBeLessThanOrEqual(Sandbox.printFrameBytes)
  })

  it("drops whole statements from the middle rather than cutting each to a notice", () => {
    const wide = "w".repeat(Sandbox.printStatementFloor * 4)
    const frame = Array.from({ length: 80 }, (_, index) => statement(`${index}:${wide}:${index}`))
    const out = printChannel.buffer(frame, 0)
    const dropped = /… (\d+) print statements elided from the middle of this frame/.exec(out)
    expect(dropped).not.toBeNull()
    expect(Number(dropped![1])).toBeGreaterThan(0)
    // The two ends of the frame are what survive, as they do inside a statement.
    expect(out.startsWith("0:")).toBe(true)
    expect(out.endsWith(":79")).toBe(true)
    expect(bytes.size(out)).toBeLessThanOrEqual(Sandbox.printFrameBytes)
  })

  it("states the statements the host never copied out, with or without others", () => {
    expect(printChannel.buffer([statement("kept")], 3))
      .toBe("kept\n… 3 further print statements were not kept: this frame printed more than the harness holds.")
    expect(printChannel.buffer([], 2)).toContain("2 further print statements were not kept")
  })

  it("states both losses when a frame overran the count and the retention alike", () => {
    const wide = "w".repeat(Sandbox.printStatementFloor * 4)
    const out = printChannel.buffer(
      Array.from({ length: 80 }, (_, index) => statement(`${index}:${wide}:${index}`)),
      7
    )
    expect(out).toContain("print statements elided from the middle of this frame")
    expect(out).toContain("7 further print statements were not kept")
    expect(out.length).toBeLessThanOrEqual(Sandbox.printFrameBytes)
  })

  it("never delivers more than one frame's budget, whatever the shape", () => {
    // The bound is the one property the channel may not break, so it is checked
    // against the shapes that put pressure on each part of the sizing: one value
    // far over the budget, values exactly at the statement floor and one either
    // side of it, and frames of every count from one to thousands.
    for (const byteCount of [0, 1, 8, 511, 512, 513, 4_000, 16_384, 40_000, 500_000]) {
      for (const count of [1, 2, 12, 32, 33, 200, 5_000]) {
        for (const unread of [0, 4_000]) {
          const frame = Array.from({ length: count }, () => statement("x".repeat(Math.min(byteCount, 20_000))))
            .map((held) => ({ text: held.text, bytes: byteCount }))
          expect(bytes.size(printChannel.buffer(frame, unread)), `bytes=${byteCount} count=${count} unread=${unread}`)
            .toBeLessThanOrEqual(Sandbox.printFrameBytes)
        }
      }
    }
  })

  it("keeps the head and tail of a value the host had already reduced", () => {
    // What `printed` hands over for a value larger than a whole frame: the two
    // ends, with the size it had. The notice has to name the original, not the
    // part that survived the first reduction.
    const out = printChannel.buffer([{ text: `HEAD${"x".repeat(1000)}TAIL`, bytes: 900_000 }], 0)
    expect(out.startsWith("HEAD")).toBe(true)
    expect(out.endsWith("TAIL")).toBe(true)
    expect(out).toContain("of 900000 bytes elided from the middle")
  })
})

describe("printChannel.render", () => {
  it("renders an ordinary value as canonical JSON, and a string as itself", () => {
    expect(printChannel.render({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`)
    expect(printChannel.render([1, 2, 3])).toBe("[1,2,3]")
    expect(printChannel.render("plain")).toBe("plain")
    expect(printChannel.render(null)).toBe("null")
  })

  it("renders mapped matches in consecutive file groups with gaps", () => {
    const matches = [
      record("src/units/widen.ts", 42, "  return value"),
      record("src/units/widen.ts", 71, "  return value"),
      record("src/units/other.ts", 12, "  return value")
    ]
    expect(printChannel.render(matches)).toBe(
      "src/units/widen.ts\n42:  return value\n--\n71:  return value\nsrc/units/other.ts\n12:  return value"
    )
  })

  it("renders the envelope around a single such member, with the count", () => {
    const found = {
      matches: [record("a.ts", 1, "one"), record("a.ts", 2, "two"), record("a.ts", 3, "three")],
      truncated: false
    }
    const shown = printChannel.render(found)
    expect(shown.split("\n")[0]).toBe(`{"truncated":false}`)
    expect(shown).toContain("matches (3):")
    expect(shown).toContain("a.ts\n1:one\n2:two\n3:three")
  })

  it("renders one or two matches, even below the table floor", () => {
    const one = record("a.ts", 2, "\t  raw | text\ncontinued")
    expect(printChannel.render([one])).toBe("a.ts\n2:\t  raw | text\ncontinued")
    expect(printChannel.render([record("a.ts", 1, ""), record("a.ts", 2, "two")]))
      .toBe("a.ts\n1:\n2:two")
    expect(printChannel.render({ filesSearched: 1, matches: [one] }))
      .toBe("{\"filesSearched\":1}\nmatches (1):\na.ts\n2:\t  raw | text\ncontinued")
    expect(printChannel.render([])).toBe("[]")
  })

  it("repeats the file header when a file returns in a later run", () => {
    expect(printChannel.render([
      record("a.ts", 1, "one"),
      record("a.ts", 2, "two"),
      record("b.ts", 3, "three"),
      record("a.ts", 4, "four")
    ])).toBe("a.ts\n1:one\n2:two\nb.ts\n3:three\na.ts\n4:four")
  })

  it("renders raw context and symbol suffixes without empty context arrays", () => {
    expect(printChannel.render([{
      ...record("apps/tui/src/transcript.ts", 330, "          cached: state.cached,"),
      before: [{ line: 329, text: "  context before" }],
      after: [{ line: 331, text: "  context after" }],
      symbol: { kind: "type", name: "Unsaved", startLine: 108, endLine: 108 }
    }])).toBe(
      "apps/tui/src/transcript.ts\n329-  context before\n" +
        "330:          cached: state.cached,  ‹type Unsaved 108-108›\n331-  context after"
    )
    expect(printChannel.render([{ ...record("a.ts", 1, "one"), before: [], after: [] }]))
      .toBe("a.ts\n1:one")
  })

  it("uses context boundaries for gaps within one file", () => {
    expect(printChannel.render([
      { ...record("a.ts", 2, "two"), after: [{ line: 3, text: "three" }] },
      { ...record("a.ts", 5, "five"), before: [{ line: 4, text: "four" }] },
      { ...record("a.ts", 9, "nine"), before: [{ line: 8, text: "eight" }] }
    ])).toBe("a.ts\n2:two\n3-three\n4-four\n5:five\n--\n8-eight\n9:nine")
  })

  it("falls through for extra keys and invalid match, context or symbol shapes", () => {
    const hit = record("a.ts", 1, "one")
    const context = { line: 2, text: "two" }
    const symbol = { kind: "type", name: "Unsaved", startLine: 108, endLine: 108 }
    const invalid = [
      { ...hit, extra: null },
      { ...hit, file: 1 },
      { ...hit, line: "1" },
      { ...hit, line: 1.5 },
      { ...hit, text: null },
      { line: 1, text: "one" },
      { file: "a.ts", text: "one" },
      { file: "a.ts", line: 1 },
      ...["before", "after"].flatMap((key) =>
        [null, {}, [null], [1], [{ line: 2 }], [{ text: "two" }], [{ ...context, line: 2.5 }], [{
          ...context,
          text: 2
        }], [{ ...context, extra: true }]]
          .map((value) => ({ ...hit, [key]: value }))
      ),
      ...[null, [], {}, { ...symbol, kind: 1 }, { ...symbol, name: 1 }, { ...symbol, startLine: 1.5 }, {
        ...symbol,
        endLine: "2"
      }, { ...symbol, extra: true }]
        .map((value) => ({ ...hit, symbol: value }))
    ] satisfies ReadonlyArray<Schema.Json>
    for (const value of invalid) {
      const rows = [hit, value, hit]
      expect(printChannel.render(rows)).toBe(printChannel.table(rows))
      expect(printChannel.render([value])).toBe(CanonicalJson.stringify([value]))
      expect(printChannel.render({ matches: rows, filesSearched: 1 })).toBe(
        `{"filesSearched":1}\nmatches (3):\n${printChannel.table(rows)}`
      )
    }
  })

  it("keeps envelopes with multiple renderable members as JSON", () => {
    const matches = [record("a.ts", 1, "one")]
    const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }]
    for (const value of [{ matches, rows }, { first: matches, second: matches }]) {
      expect(printChannel.render(value)).toBe(CanonicalJson.stringify(value))
    }
  })

  it("uses the ordered union of keys, even when the first record is empty", () => {
    expect(printChannel.render([{}, { b: 2, a: 1 }, { a: null, c: 3 }])).toBe(
      "b | a | c\n |  | \n2 | 1 | \n | null | 3"
    )
  })

  it("tables incomplete matches but recognizes reordered match keys", () => {
    expect(printChannel.render([record("a", 1, "one"), { file: "b", line: 2 }, record("c", 3, "three")]))
      .toBe("file | line | text\na | 1 | one\nb | 2 | \nc | 3 | three")
    expect(printChannel.render([
      record("a", 1, "one"),
      { line: 2, file: "b", text: "two" },
      record("c", 3, "three")
    ])).toBe("a\n1:one\nb\n2:two\nc\n3:three")
  })

  it("leaves absent members empty while preserving null and empty containers", () => {
    expect(printChannel.render([
      { name: "absent" },
      { name: "null", value: null },
      { name: "array", value: [] },
      { name: "object", value: {} }
    ])).toBe("name | value\nabsent | \nnull | null\narray | []\nobject | {}")
  })

  it("does not fill absent columns from the object prototype", () => {
    expect(printChannel.render([
      { name: "absent" },
      { name: "own", constructor: null, toString: [] },
      { name: "other" }
    ])).toBe("name | constructor | toString\nabsent |  | \nown | null | []\nother |  | ")
  })

  it.each([false, true])("saves UTF-8 bytes for a realistic grep result with optional symbols: %s", (withSymbols) => {
    const symbol = { endLine: 108, kind: "type", name: "Unsaved", startLine: 108 }
    const found = {
      filesSearched: 42,
      matches: [
        {
          after: [],
          before: [],
          file: "apps/tui/src/transcript.ts",
          line: 330,
          ...(withSymbols ? { symbol } : {}),
          text: "          cached: state.cached,"
        },
        {
          after: [],
          before: [],
          file: "apps/tui/src/transcript.ts",
          line: 342,
          text: "          cached: undefined, // …"
        },
        {
          after: [],
          before: [],
          file: "apps/tui/src/transcript.ts",
          line: 355,
          ...(withSymbols ? { symbol } : {}),
          text: "          cached: next.cached,"
        }
      ],
      skippedBinary: 0,
      truncated: false
    }
    const shown = printChannel.render(found)
    const suffix = withSymbols ? "  ‹type Unsaved 108-108›" : ""
    expect(shown).toBe(
      "{\"filesSearched\":42,\"skippedBinary\":0,\"truncated\":false}\n" +
        "matches (3):\napps/tui/src/transcript.ts\n" +
        `330:          cached: state.cached,${suffix}\n--\n` +
        "342:          cached: undefined, // …\n--\n" +
        `355:          cached: next.cached,${suffix}`
    )
    expect(bytes.size(printChannel.table(found.matches)!)).toBeLessThan(
      bytes.size(CanonicalJson.stringify(found.matches))
    )
    expect(bytes.size(shown)).toBeLessThan(bytes.size(CanonicalJson.stringify(found)))
  })

  it("renders exact failed-call envelopes with or without a hint, regardless of key order", () => {
    expect(printChannel.render({ ok: false, error: { code: "flow_failed", message: "File not found" } }))
      .toBe("failed (flow_failed): File not found")
    expect(printChannel.render({ error: { message: "File not found", code: "flow_failed" }, ok: false }))
      .toBe("failed (flow_failed): File not found")
    expect(printChannel.render({
      ok: false,
      error: { code: "flow_failed", message: "File not found", hint: "Check the path" }
    })).toBe("failed (flow_failed): File not found — hint: Check the path")
    expect(printChannel.render({
      error: { hint: "Check the path", message: "File not found", code: "flow_failed" },
      ok: false
    })).toBe("failed (flow_failed): File not found — hint: Check the path")
    expect(printChannel.render({ ok: false, error: { code: "", message: "", hint: "" } }))
      .toBe("failed ():  — hint: ")
  })

  it("keeps failed-call envelopes with extra keys or invalid shapes as canonical JSON", () => {
    const error = { code: "flow_failed", message: "File not found" }
    for (
      const value of [
        { ok: false, error, extra: null },
        { ok: false, error: { ...error, extra: null } },
        { ok: false, error: { ...error, hint: "Check the path", extra: null } },
        { ok: true, error },
        { error },
        { ok: false, extra: null },
        { ok: false, error: null },
        { ok: false, error: "File not found" },
        { ok: false, error: [] },
        { ok: false, error: {} },
        { ok: false, error: { code: "flow_failed" } },
        { ok: false, error: { message: "File not found" } },
        { ok: false, error: { ...error, code: 1 } },
        { ok: false, error: { ...error, message: null } },
        { ok: false, error: { ...error, hint: null } },
        { ok: false, error: { ...error, hint: 1 } }
      ] satisfies ReadonlyArray<Schema.Json>
    ) {
      expect(printChannel.render(value)).toBe(CanonicalJson.stringify(value))
    }
  })

  it("quotes a cell that would be ambiguous, and leaves the plain ones plain", () => {
    const rows = [
      { name: "plain", note: "no separator" },
      { name: "piped", note: "a | b" },
      { name: "lined", note: "one\ntwo" }
    ]
    const shown = printChannel.render(rows)
    expect(shown).toContain("plain | no separator")
    expect(shown).toContain(`piped | "a | b"`)
    expect(shown).toContain(`lined | "one\\ntwo"`)
  })

  it("is shorter than the JSON at the smallest shape it applies to", () => {
    // Three uniform rows, two one-character keys and one-character values:
    // the table wins by 20 bytes. Sparse records need not save bytes.
    const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }]
    expect(printChannel.render(rows)).toBe("a | b\n1 | 2\n3 | 4\n5 | 6")
    expect(printChannel.render(rows).length).toBe(`[{"a":1,"b":2},{"a":3,"b":4},{"a":5,"b":6}]`.length - 20)
    const wrapped = { rows, ok: true }
    expect(printChannel.render(wrapped).length).toBeLessThan(JSON.stringify(wrapped).length)
  })

  it("refuses a table below the row or column floor, or when any element is not a record", () => {
    const wide = "w".repeat(80)
    // Too few rows, a scalar element, fewer than two union columns, and a
    // nested array of arrays: every one stays JSON.
    for (
      const value of [
        [{ name: "a", text: wide }, { name: "b", text: wide }],
        [{ a: 1 }, { b: 2 }],
        [record("a", 1, wide), "not a record", record("c", 3, wide)],
        [{ file: wide }, { file: wide }, { file: wide }],
        [{}, {}, {}],
        [[1, 2], [3, 4], [5, 6]]
      ] satisfies ReadonlyArray<Schema.Json>
    ) {
      expect(printChannel.render(value).startsWith("[")).toBe(true)
    }
  })

  it("refuses the envelope form when two members would both be tables", () => {
    const wide = "w".repeat(80)
    const rows = [record("a", 1, wide), record("b", 2, wide), record("c", 3, wide)]
    expect(printChannel.render({ first: rows, second: rows }).startsWith("{")).toBe(true)
  })
})

describe("printChannel.capacity", () => {
  it("keeps every statement a budget can carry at its own size", () => {
    expect(printChannel.capacity(Array.from({ length: 200 }, () => statement("line")), Sandbox.printFrameBytes))
      .toBe(200)
  })

  it("keeps fewer of the statements that cost the whole floor", () => {
    const wide = Array.from({ length: 200 }, () => ({ text: "w", bytes: 40_000 }))
    const kept = printChannel.capacity(wide, Sandbox.printFrameBytes)
    expect(kept).toBeGreaterThan(20)
    expect(kept).toBeLessThan(40)
  })

  it("keeps nothing a budget cannot afford at all", () => {
    expect(printChannel.capacity([{ text: "", bytes: 40_000 }], 10)).toBe(0)
  })
})

describe("elide slices by UTF-8 byte boundaries", () => {
  const samples = [
    ["ASCII", "A"],
    ["CJK", "界"],
    ["combining mark", "\u0301"],
    ["astral character", "\u{1F600}"]
  ] as const
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u
  const valid = (slice: string, limit: number): void => {
    const points = [...slice]
    expect(bytes.size(slice)).toBeLessThanOrEqual(limit)
    expect(slice).toBe(points.join(""))
    expect([...points.join("")]).toHaveLength(points.length)
    expect(loneSurrogate.test(slice)).toBe(false)
  }

  it.each(samples)("keeps %s whole only when the head budget reaches its byte size", (_name, sample) => {
    const exact = bytes.size(sample)
    for (const limit of [exact - 1, exact, exact + 1]) {
      const slice = elide.headSlice(`${sample}Z`, limit)
      valid(slice, limit)
      expect(slice).toBe(limit < exact ? "" : limit === exact ? sample : `${sample}Z`)
    }
  })

  it.each(samples)("keeps %s whole only when the tail budget reaches its byte size", (_name, sample) => {
    const exact = bytes.size(sample)
    for (const limit of [exact - 1, exact, exact + 1]) {
      const slice = elide.tailSlice(`A${sample}`, limit)
      valid(slice, limit)
      expect(slice).toBe(limit < exact ? "" : limit === exact ? sample : `A${sample}`)
    }
  })

  it("keeps the ASCII slicing contract unchanged", () => {
    expect(elide.headSlice("plain", 3)).toBe("pla")
    expect(elide.headSlice("plain", 0)).toBe("")
    expect(elide.headSlice("plain", 99)).toBe("plain")
    expect(elide.tailSlice("plain", 3)).toBe("ain")
    expect(elide.tailSlice("plain", 99)).toBe("plain")
  })

  it("leaves no half of a pair in a middle elision, and counts what it kept", () => {
    const smile = "\u{1F600}"
    const text = `${"a".repeat(9)}${smile.repeat(20)}${"z".repeat(9)}`
    const whole = bytes.size(text)
    const out = elide.middleFrom(text, whole, 21, printChannel.recall)
    expect(loneSurrogate.test(out)).toBe(false)
    const kept = bytes.size(out) - elide.noticeCost(whole, printChannel.recall)
    expect(Number(/… (\d+) of/.exec(out)![1])).toBe(whole - Math.max(0, kept))
    expect(bytes.size(out)).toBeLessThanOrEqual(21 + elide.noticeCost(whole, printChannel.recall))
  })

  it("keeps a head elision off a pair too, and says what it really dropped", () => {
    const smile = "\u{1F600}"
    const text = `${smile.repeat(10)}tail`
    const out = elide.head(text, 5, "recall")
    expect(out.startsWith(smile)).toBe(true)
    expect(out).toContain(`+${bytes.size(text) - bytes.size(smile)}b`)
  })
})

describe("elide.noticeCost", () => {
  it("bounds the notice a value of that size can produce", () => {
    const text = "q".repeat(5_000)
    const shortened = elide.middleFrom(text, text.length, 1_000, printChannel.recall)
    expect(shortened.length - 1_000).toBeLessThanOrEqual(elide.noticeCost(text.length, printChannel.recall))
  })

  it("costs nothing for a value there is nothing to say about", () => {
    expect(elide.noticeCost(0, printChannel.recall)).toBe(0)
  })
})
