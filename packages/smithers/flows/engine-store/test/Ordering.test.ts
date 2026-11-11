import { describe, expect, it } from "vitest"
import { compareText } from "../src/internal/Ordering.ts"

describe("host-independent text ordering", () => {
  it("orders by UTF-16 code units and admits equality", () => {
    expect(compareText("a", "b")).toBe(-1)
    expect(compareText("b", "a")).toBe(1)
    expect(compareText("same", "same")).toBe(0)
    // These pairs distinguish code-unit order from locale collation and code-point order.
    for (const [left, right] of [["B", "a"], ["z", "é"], ["\u{1F600}", "\uFFFF"]]) {
      expect(compareText(left!, right!)).toBe(-1)
      expect(compareText(right!, left!)).toBe(1)
    }
  })
})
