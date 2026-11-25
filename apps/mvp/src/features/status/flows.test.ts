import { describe, expect, test } from "vitest"
import { answerOf } from "./flows"

describe("answerOf", () => {
  test("keeps words, decisions and decisions with a note, and nothing else", () => {
    expect(answerOf("main")).toBe("main")
    expect(answerOf(false)).toBe(false)
    expect(answerOf({ approved: true, note: "Go." })).toEqual({ approved: true, note: "Go." })
    for (const value of [null, 1, {}, [], { approved: true }, { approved: "yes", note: "" }, { approved: true, note: 1 }]) {
      expect(answerOf(value)).toBeNull()
    }
  })
})
