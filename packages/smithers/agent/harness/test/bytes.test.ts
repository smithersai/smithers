import { describe, expect, it } from "vitest"
import * as bytes from "../src/internal/bytes.ts"
import * as elide from "../src/internal/elide.ts"

describe("bytes.tailSlice", () => {
  it.each([
    "",
    "ascii",
    "a\u007f\u0080\u07ff\u0800\uffff",
    "a😀é中\ud800z",
    "x\udc00",
    "\udc00",
    "\ue000\udc00",
    "\udc00\ud800",
    "😀"
  ])(
    "matches UTF-8 suffix boundaries for %j",
    (text) => {
      const characters = [...text]
      for (let limit = -1; limit <= bytes.size(text) + 1; limit++) {
        let expected = ""
        for (let index = characters.length - 1; index >= 0; index--) {
          const candidate = characters[index]! + expected
          if (bytes.size(candidate) > limit) break
          expected = candidate
        }
        expect(bytes.tailSlice(text, limit)).toBe(expected)
      }
    }
  )

  it("keeps or excludes the entire surrogate pair at the cut", () => {
    expect(bytes.tailSlice("prefix😀tail", 7)).toBe("tail")
    expect(bytes.tailSlice("prefix😀tail", 8)).toBe("😀tail")
  })

  it("keeps the complete UTF-8 suffix of a multi-megabyte print", () => {
    const limit = 8192
    const suffix = "😀" + "x".repeat(limit - 4)
    const text = "p".repeat(3 * 1024 * 1024) + suffix
    expect(elide.tailSlice(text, limit)).toBe(suffix)
    expect(bytes.size(elide.tailSlice(text, limit))).toBe(limit)
  })
})
