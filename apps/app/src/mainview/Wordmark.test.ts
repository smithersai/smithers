import { describe, expect, test } from "bun:test"
import { WORDMARK } from "./Wordmark"

describe("WORDMARK", () => {
  test("keeps every row the same width", () => {
    expect(new Set(WORDMARK.map((row) => [...row].length)).size).toBe(1)
  })

  test("casts the bottom shadow only under ink", () => {
    const above = [...WORDMARK[WORDMARK.length - 2]]
    const floating = [...WORDMARK[WORDMARK.length - 1]].flatMap((cell, column) =>
      cell !== " " && above[column] === " " ? [column] : [],
    )
    expect(floating).toEqual([])
  })
})
