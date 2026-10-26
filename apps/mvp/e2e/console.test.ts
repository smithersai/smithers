import { describe, expect, it } from "vitest"
import { consoleLine, wholeLine } from "./console"

// The browser log's lines (e2e/console.ts): Chrome's preview, which `text()` returns, keeps an object's first five
// properties; the line written from the values keeps them all.

/** What `text()` gave for the engine worker's `sandbox.call` on smithers.sh, 2026-10-25, and what was logged. */
const preview = "[16:06:23.847] INFO (#8556): sandbox.call {runId: r1, stepKey: k1, attempt: 8, tier: sealed, tool: write}"
const logged = [
  "[16:06:23.847] INFO (#8556): sandbox.call",
  { runId: "r1", stepKey: "k1", attempt: 8, tier: "sealed", tool: "write", outcome: "done", callId: "c1", feature: "sandbox" },
]

describe("wholeLine", () => {
  it("writes out every field of an object argument the preview cut at five", () => {
    expect(wholeLine(preview, logged)).toBe(
      "[16:06:23.847] INFO (#8556): sandbox.call " +
        `{"runId":"r1","stepKey":"k1","attempt":8,"tier":"sealed","tool":"write","outcome":"done","callId":"c1","feature":"sandbox"}`,
    )
  })

  it("keeps text() where it is already whole: strings, numbers, booleans, null or nothing", () => {
    expect(wholeLine("ready 3 true null", ["ready", 3, true, null])).toBe("ready 3 true null")
    expect(wholeLine("", [])).toBe("")
  })

  it("keeps text() where the first argument formats the rest", () => {
    for (const format of ["%s", "%d", "%i", "%f", "%o", "%O", "%c"]) {
      expect(wholeLine("formatted", [`${format}[16:06] INFO`, { a: 1 }])).toBe("formatted")
    }
  })

  it("keeps text() when the values couldn't be read", () => {
    expect(wholeLine(preview, undefined)).toBe(preview)
  })

  it("writes arrays and nested objects as JSON, and a value JSON has no notation for as itself", () => {
    expect(wholeLine("x", ["rows", [1, { b: [2] }], undefined])).toBe(`rows [1,{"b":[2]}] undefined`)
  })
})

describe("consoleLine", () => {
  it("joins strings as themselves and everything else as JSON", () => {
    expect(consoleLine(["a", 1, false, null, { k: "v" }])).toBe(`a 1 false null {"k":"v"}`)
  })
})
