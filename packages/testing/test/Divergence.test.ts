/**
 * Divergence has to detect drift in the values an engine journals, not only in
 * the plain records the happy-path test used. Every case here is a pair of
 * journals whose entries the previous hand-rolled canonicalizer rendered
 * identically, so `assertNoDivergence` succeeded on genuinely different input.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { assertNoDivergence, firstDivergence } from "../src/Divergence.vibe"
import type { JournalEntryLike } from "../src/EngineSubject.vibe"

const entry = (value: unknown, overrides: Partial<JournalEntryLike> = {}): JournalEntryLike => ({
  index: 0,
  stepKey: "step",
  kind: "step",
  outcome: "completed",
  value,
  ...overrides
})

const divergesOn = (expected: unknown, actual: unknown): string => {
  const found = firstDivergence([entry(expected)], [entry(actual)])
  return Option.isNone(found) ? "(none)" : found.value.field
}

describe("Divergence values the collapsing canonicalizer compared equal", () => {
  it("separates two different dates", () => {
    expect(divergesOn(new Date(0), new Date(1))).toBe("value")
    expect(divergesOn(new Date(0), new Date(0))).toBe("(none)")
  })

  it("separates an invalid date from a valid one", () => {
    expect(divergesOn(new Date(Number.NaN), new Date(0))).toBe("value")
  })

  it("separates a map from a set and two different maps", () => {
    expect(divergesOn(new Map([["a", 1]]), new Set([1, 2]))).toBe("value")
    expect(divergesOn(new Map([["a", 1]]), new Map([["a", 2]]))).toBe("value")
    expect(divergesOn(new Map([["a", 1], ["b", 2]]), new Map([["b", 2], ["a", 1]]))).toBe("(none)")
    expect(divergesOn(new Set([1, 2]), new Set([2, 1]))).toBe("(none)")
  })

  it("separates the two zeros and the non-finite numbers", () => {
    expect(divergesOn(-0, 0)).toBe("value")
    expect(divergesOn(Number.NaN, Number.POSITIVE_INFINITY)).toBe("value")
    expect(divergesOn(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe("value")
    expect(divergesOn(Number.NaN, Number.NaN)).toBe("(none)")
  })

  it("separates two instances of the same class and two different classes", () => {
    class Ticket {
      readonly id: string
      constructor(id: string) {
        this.id = id
      }
    }
    class Receipt {
      readonly id: string
      constructor(id: string) {
        this.id = id
      }
    }
    expect(divergesOn(new Ticket("a"), new Ticket("b"))).toBe("value")
    expect(divergesOn(new Ticket("a"), new Receipt("a"))).toBe("value")
    expect(divergesOn(new Ticket("a"), new Ticket("a"))).toBe("(none)")
  })

  it("separates two errors by message and ignores the stack that differs on every construction", () => {
    expect(divergesOn(new Error("boom"), new Error("bang"))).toBe("value")
    expect(divergesOn(new Error("boom"), new TypeError("boom"))).toBe("value")
    expect(divergesOn(new Error("boom"), new Error("boom"))).toBe("(none)")
  })

  it("separates a regular expression from an equal-looking one", () => {
    expect(divergesOn(/a/g, /a/i)).toBe("value")
    expect(divergesOn(/a/g, /a/g)).toBe("(none)")
  })

  it("reports a cyclic value instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { name: "a" }
    cyclic.self = cyclic
    const other: Record<string, unknown> = { name: "b" }
    other.self = other
    expect(divergesOn(cyclic, other)).toBe("value")
    const twin: Record<string, unknown> = { name: "a" }
    twin.self = twin
    expect(divergesOn(cyclic, twin)).toBe("(none)")
  })

  it("compares a bigint instead of throwing a TypeError out of the typed channel", async () => {
    expect(divergesOn(1n, 2n)).toBe("value")
    expect(divergesOn(1n, 1n)).toBe("(none)")
    const exit = await Effect.runPromiseExit(assertNoDivergence([entry(1n)], [entry(2n)]))
    expect(exit._tag).toBe("Failure")
  })

  it("compares a symbol and a function instead of collapsing both to an empty record", () => {
    expect(divergesOn(Symbol("a"), Symbol("b"))).toBe("value")
    expect(divergesOn(() => 1, "not a function")).toBe("value")
  })

  it("separates undefined from null and from an absent property", () => {
    expect(divergesOn({ a: undefined }, { a: null })).toBe("value")
    expect(divergesOn({ a: undefined }, {})).toBe("value")
  })
})

describe("Divergence entry attribution", () => {
  it("reports a mismatched entry index", () => {
    const expected = [entry(1, { index: 0 }), entry(2, { index: 1 })]
    const actual = [entry(1, { index: 0 }), entry(2, { index: 7 })]
    const found = Option.getOrThrow(firstDivergence(expected, actual))
    expect(found.field).toBe("index")
    expect(found.expected).toBe(1)
    expect(found.actual).toBe(7)
  })

  it("reports a length mismatch as a missing entry", () => {
    const shorter = [entry(1, { index: 0 })]
    const longer = [entry(1, { index: 0 }), entry(2, { index: 1 })]
    const missing = Option.getOrThrow(firstDivergence(shorter, longer))
    expect(missing).toEqual({ index: 1, field: "entry", expected: undefined, actual: longer[1] })
    const extra = Option.getOrThrow(firstDivergence(longer, shorter))
    expect(extra).toEqual({ index: 1, field: "entry", expected: longer[1], actual: undefined })
  })

  it("uses the array position when both sparse journals omit the entry", () => {
    const expected = new Array<JournalEntryLike>(1)
    const actual = new Array<JournalEntryLike>(1)
    expect(Option.getOrThrow(firstDivergence(expected, actual))).toEqual({
      index: 0,
      field: "entry",
      expected: undefined,
      actual: undefined
    })
  })

  it("succeeds on identical journals", async () => {
    const journal = [entry({ a: 1 }, { index: 0 }), entry([1, 2, 3], { index: 1 })]
    const exit = await Effect.runPromiseExit(assertNoDivergence(journal, [...journal]))
    expect(exit._tag).toBe("Success")
  })
})
