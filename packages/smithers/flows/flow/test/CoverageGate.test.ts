import { describe, expect, it } from "vitest"
import { coversWholeSuite } from "./CoverageGate.ts"

describe("coversWholeSuite", () => {
  it("is true for an unfiltered run, which is what the gate target invokes", () => {
    expect(coversWholeSuite({ filter: [], options: {} })).toBe(true)
    expect(coversWholeSuite({ filter: [], options: { changed: false } })).toBe(true)
  })

  it("is false for a file filter", () => {
    expect(coversWholeSuite({ filter: ["test/Poll.test.ts"], options: {} })).toBe(false)
  })

  it("is false for a test name pattern", () => {
    expect(coversWholeSuite({ filter: [], options: { testNamePattern: "polls" } })).toBe(false)
    expect(coversWholeSuite({ filter: [], options: { testNamePattern: /polls/ } })).toBe(false)
  })

  it("is false for --changed and --related", () => {
    expect(coversWholeSuite({ filter: [], options: { changed: true } })).toBe(false)
    expect(coversWholeSuite({ filter: [], options: { changed: "main" } })).toBe(false)
    expect(coversWholeSuite({ filter: [], options: { related: ["src/Poll.ts"] } })).toBe(false)
  })
})
