import { describe, expect, it } from "vitest"
import * as Observation from "../src/Observation.vibe"

describe("Observation", () => {
  it("builds a typed observation", () => {
    expect(Observation.make("catalog", `"x" is not a catalog entry`)).toEqual({
      kind: "catalog",
      message: `"x" is not a catalog entry`
    })
  })

  it("caps a message on a code point and keeps it well-formed", () => {
    const cut = 8192 - "[truncated]".length
    const message = Observation.make("call_failed", `${"x".repeat(cut - 1)}\u{1F680}${"y".repeat(100)}`).message
    expect(message === `${"x".repeat(cut - 1)}[truncated]`).toBe(true)
    expect(Observation.make("script_failed", "bad \uD83D").message).toBe("bad \uFFFD")
    expect(Observation.render({ kind: "shape", message: "old \uDE80" })).toBe("[shape] old \uFFFD")
  })

  it("renders one context line", () => {
    expect(Observation.render(Observation.make("shape", "no block"))).toBe("[shape] no block")
  })
})
