import { describe, expect, it } from "vitest"
import * as Outcome from "../src/Outcome.vibe"
import * as Script from "../src/Script.vibe"

describe("Outcome", () => {
  it("builds done", () => {
    expect(Outcome.done({ ok: true })).toEqual({ _tag: "Done", value: { ok: true } })
  })

  it("builds to", () => {
    const script = Script.make("return done(null)")
    expect(Outcome.to(script)).toEqual({ _tag: "To", script })
  })

  it("builds park with and without a message", () => {
    expect(Outcome.park("quota", "over budget")).toEqual({
      _tag: "Park",
      reason: { code: "quota", message: "over budget" }
    })
    expect(Outcome.park("timer")).toEqual({ _tag: "Park", reason: { code: "timer", message: "" } })
  })
})
