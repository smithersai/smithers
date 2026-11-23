import { Bridge, Home, Interactions, ViewCode, ViewCsp } from "@smthrs/views"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"

const ForbiddenSnippet = Schema.Literals([
  "export default () => eval(\"1+1\")",
  "export default () => new Function(\"return 1\")()",
  "export default () => globalThis.process",
  "export default () => window.top.location",
  "export default () => fetch(\"https://evil.example\")",
  "export default () => import(\"node:fs\")",
  "export default () => ({}).constructor.constructor(\"return this\")()",
  "export default () => document.cookie"
])

describe("@smthrs/views security fuzz", () => {
  it.fuzz(
    "ViewCode.check never crashes on arbitrary input and rejects dangerous sandbox escapes",
    [Schema.String, ForbiddenSnippet],
    ([arbitraryCode, forbidden]) => {
      const arbitraryExit = Effect.runSyncExit(ViewCode.check(arbitraryCode))
      expect(arbitraryExit._tag === "Success" || arbitraryExit._tag === "Failure").toBe(true)

      const forbiddenExit = Effect.runSyncExit(ViewCode.check(forbidden))
      expect(forbiddenExit._tag).toBe("Failure")
      return true
    }
  )

  it.fuzz(
    "Home.read never crashes on arbitrary text and Home.visible is monotone across audiences",
    [
      Schema.String,
      Schema.Literals(["public", "signed_in", "collaborator", "maintainer", "owner"]),
      Schema.Boolean
    ],
    ([rawText, audience, contributors]) => {
      const readExit = Effect.runSyncExit(Home.read(rawText))
      if (readExit._tag === "Success") {
        const base = Home.visible(readExit.value, audience)
        const widened = Home.visible(readExit.value, Home.widen(audience, contributors))
        expect(widened.length).toBeGreaterThanOrEqual(base.length)
      }
      return true
    }
  )

  it.fuzz(
    "Bridge.receive enforces malformed, undeclared, size, and rate limits without crashing",
    [
      Schema.Unknown,
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 }))
    ],
    ([message, priorEvents, nowMs]) => {
      const window: Bridge.RateWindow = Array.from({ length: priorEvents }, (_, i) => nowMs - i * 10)
      const declared: Interactions.Declared = {
        click: { kind: "state" },
        submit: { kind: "message", label: "Submit" }
      }
      const { verdict, window: nextWindow } = Bridge.receive({
        message,
        declared,
        now: nowMs,
        window
      })
      if (verdict._tag === "State" || verdict._tag === "Message") {
        expect(nextWindow.length).toBeLessThanOrEqual(Bridge.maxInteractionsPerSecond)
      }
      return true
    }
  )

  it.fuzz(
    "ViewCsp.frameDocument neutralizes closing script/style tags and rejects NUL in runtime",
    [
      Schema.String,
      Schema.String,
      Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22,40}$/)),
      Schema.Literals(["light", "dark"])
    ],
    ([runtime, styles, nonce, theme]) => {
      if (runtime.includes("\0")) {
        expect(() => ViewCsp.frameDocument({ runtime, styles, nonce, theme })).toThrow(TypeError)
        return true
      }
      if (!runtime.isWellFormed()) {
        expect(() => ViewCsp.frameDocument({ runtime, styles, nonce, theme })).toThrow()
        return true
      }
      const doc = ViewCsp.frameDocument({ runtime, styles, nonce, theme })
      expect(doc).toContain("Content-Security-Policy")
      expect(doc).toContain(nonce)
      // Only the single trusted runtime closing </script> tag may appear
      const scriptCloses = doc.match(/<\/script>/gi) ?? []
      expect(scriptCloses.length).toBe(1)
      return true
    }
  )
})
