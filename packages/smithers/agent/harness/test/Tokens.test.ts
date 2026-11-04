import { describe, expect, it } from "vitest"
import * as Tokens from "../src/Tokens.vibe"

const segment = (zone: "prefix" | "tail", value: number, estimated = true) =>
  new Tokens.Segment({
    digest: `${zone}-${value}`,
    zone,
    tokens: new Tokens.Count({ value, estimated })
  })

describe("Tokens", () => {
  describe("estimate", () => {
    it("charges nothing for the empty string", () => {
      expect(Tokens.estimate("")).toBe(0)
    })

    it("charges one token for any text shorter than the four-character unit", () => {
      expect(Tokens.estimate("a")).toBe(1)
      expect(Tokens.estimate(" ")).toBe(1)
      expect(Tokens.estimate("abc")).toBe(1)
      expect(Tokens.estimate("abcd")).toBe(1)
    })

    it("charges a second token one character over the four-character unit", () => {
      expect(Tokens.estimate("abcde")).toBe(2)
    })

    it("charges plain prose exactly four characters per token", () => {
      expect(Tokens.estimate("a".repeat(400))).toBe(100)
    })

    it("charges code punctuation above its character cost", () => {
      // Nine characters of prose fit in three tokens; nine of punctuation do not.
      expect(Tokens.estimate("aaaaaaaaa")).toBe(3)
      expect(Tokens.estimate("=========")).toBe(4)
    })

    it("charges every character the regex class treats as code", () => {
      for (const character of ["{", "}", "(", ")", "[", "]", ";", "=", "<", ">", "`"]) {
        expect(Tokens.estimate(character.repeat(16))).toBeGreaterThan(Tokens.estimate("a".repeat(16)))
      }
    })

    it("charges newlines above their character cost", () => {
      expect(Tokens.estimate("\n\n\n\n")).toBe(3)
      expect(Tokens.estimate("aaaa")).toBe(1)
    })

    it("charges code punctuation and newlines together on the same text", () => {
      // 8 characters, 4 of them code, 2 of them newlines:
      // ceil((8 + 4 * 0.75 + 2 * 1.5) / 4) = ceil(3.5) = 4.
      expect(Tokens.estimate("{a}\n(b)\n")).toBe(4)
    })

    it("measures text in UTF-16 code units, not code points", () => {
      // One astral emoji is two code units, so it costs what two letters cost.
      expect(Tokens.estimate("\u{1F600}")).toBe(Tokens.estimate("ab"))
      expect(Tokens.estimate("日本語テキスト")).toBe(2)
    })

    it("stays exact on a very large input", () => {
      expect(Tokens.estimate("a".repeat(1_000_000))).toBe(250_000)
    })
  })

  describe("count", () => {
    it("marks every count estimated, including a zero one", () => {
      expect(Tokens.count("")).toEqual(new Tokens.Count({ value: 0, estimated: true }))
      expect(Tokens.count("abcd").estimated).toBe(true)
    })

    it("defaults to the built-in estimator", () => {
      expect(Tokens.count("abcde").value).toBe(Tokens.estimate("abcde"))
    })

    it("uses a supplied estimator instead of the default", () => {
      expect(Tokens.count("abcde", () => 42).value).toBe(42)
    })

    it("rounds a fractional estimator result up", () => {
      expect(Tokens.count("x", () => 0.1).value).toBe(1)
      expect(Tokens.count("x", () => 1.5).value).toBe(2)
    })

    it("clamps a negative estimator result to zero", () => {
      expect(Tokens.count("x", () => -5).value).toBe(0)
      expect(Tokens.count("x", () => -0.5).value).toBe(0)
    })

    it("passes the exact text through to the estimator", () => {
      const seen: Array<string> = []
      Tokens.count("  padded  ", (text) => {
        seen.push(text)
        return 1
      })
      expect(seen).toEqual(["  padded  "])
    })
  })

  describe("combine", () => {
    it("reports a zero, un-estimated accounting for no segments", () => {
      const accounting = Tokens.combine([])
      expect(accounting.prefix.value).toBe(0)
      expect(accounting.tail.value).toBe(0)
      expect(accounting.total.value).toBe(0)
      expect(accounting.total.estimated).toBe(false)
      expect(accounting.bySegment).toEqual([])
    })

    it("splits the total by cache zone", () => {
      const accounting = Tokens.combine([segment("prefix", 10), segment("tail", 3), segment("prefix", 7)])
      expect(accounting.prefix.value).toBe(17)
      expect(accounting.tail.value).toBe(3)
      expect(accounting.total.value).toBe(20)
    })

    it("reports a single-zone accounting with the other zone at zero", () => {
      expect(Tokens.combine([segment("prefix", 5)]).tail.value).toBe(0)
      expect(Tokens.combine([segment("tail", 5)]).prefix.value).toBe(0)
    })

    it("marks the whole accounting estimated when any one segment is", () => {
      const exact = [segment("prefix", 4, false), segment("tail", 6, false)]
      expect(Tokens.combine(exact).total.estimated).toBe(false)
      expect(Tokens.combine([...exact, segment("tail", 0, true)]).total.estimated).toBe(true)
    })

    it("keeps the supplied segments as the breakdown, in order", () => {
      const segments = [segment("tail", 1), segment("prefix", 2)]
      expect(Tokens.combine(segments).bySegment.map((item) => item.digest)).toEqual(["tail-1", "prefix-2"])
    })

    it("counts a zero-token segment without changing the total", () => {
      const withZero = Tokens.combine([segment("prefix", 0), segment("prefix", 9)])
      expect(withZero.total.value).toBe(9)
      expect(withZero.bySegment).toHaveLength(2)
    })
  })
})
