import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as JsonBoundary from "../src/JsonBoundary.ts"
import * as Outcome from "../src/Outcome.ts"
import * as Script from "../src/Script.ts"

describe("Outcome", () => {
  it("builds done", () => {
    expect(Outcome.done({ ok: true })).toEqual({ _tag: "Done", value: { ok: true } })
  })

  it("builds to", () => {
    const script = Script.make("return done(null)")
    expect(Outcome.to(script)).toEqual({ _tag: "To", script })
  })

  it.each(["", "return done(1)", "return done(\"🌱\")"])("builds to from text %j", (text) => {
    const expected = { _tag: "To", script: Script.make(text) }
    expect(Outcome.to(text)).toEqual(expected)
    expect(Outcome.to({ text })).toEqual(expected)
    expect(Outcome.to({ text, digest: "FORGED" })).toEqual(expected)
  })

  it("builds park with and without a message", () => {
    expect(Outcome.park("quota", "over budget")).toEqual({
      _tag: "Park",
      reason: { code: "quota", message: "over budget" }
    })
    expect(Outcome.park("timer")).toEqual({ _tag: "Park", reason: { code: "timer", message: "" } })
  })

  it("decodeOutcome returns none instead of throwing on a To successor with an unpaired surrogate", () => {
    expect(Option.isNone(JsonBoundary.decodeOutcome({ _tag: "To", script: "\ud800" }))).toBe(true)
    expect(Option.isNone(JsonBoundary.decodeOutcome({ _tag: "To", script: { text: "a\udc00" } }))).toBe(true)
  })
})
