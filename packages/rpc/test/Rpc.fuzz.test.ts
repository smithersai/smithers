import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeCrypto from "node:crypto"
import { describe, expect, it } from "vitest"
import { Refusal, Sha256, WebUrl } from "../src/index.ts"

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/rpc WebUrl, Sha256 & Refusal fuzz invariants", () => {
  it("WebUrl schemas NEVER accept dangerous schemes (javascript:/data:/file:) or open-redirect protocol-relative paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        Schema.Literals([
          "javascript:alert(1)",
          "JAVASCRIPT:alert(1)",
          "data:text/html,<script>alert(1)</script>",
          "vbscript:msgbox(1)",
          "file:///etc/passwd",
          "//evil.example/path",
          "/\\evil.example",
          "/safe/path?a=1#frag",
          "https://smithers.sh/docs"
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.sync(() => {
            const httpRes = WebUrl.HttpUrlSchema.safeParse(raw)
            if (httpRes.success) {
              if (!/^https?:\/\//i.test(httpRes.data)) return false
            }
            const relRes = WebUrl.RelativeUrlPathSchema.safeParse(raw)
            if (relRes.success) {
              if (!relRes.data.startsWith("/")) return false
              if (relRes.data.startsWith("//")) return false
              if (relRes.data.includes("\\")) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Sha256.digestSync matches Node crypto on well-formed UTF-16 and rejects unpaired surrogates with TypeError", async () => {
    const arb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(256))))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (text) =>
          Effect.sync(() => {
            if (!isWellFormed(text)) {
              try {
                Sha256.digestSync(text)
                return false
              } catch (err) {
                return err instanceof TypeError
              }
            }
            const expected = NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex")
            return Sha256.digestSync(text) === expected
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Refusal.storedRefusal / refusalFromStored round-trips and retryAfterHeader never throws", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals([400, 401, 403, 404, 409, 429, 500, 502, 503]),
        message: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
        retryHeader: Schema.OptionFromUndefinedOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(32))))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, message, retryHeader }) =>
          Effect.sync(() => {
            const r = Refusal.refusalOf({ body: null, status, message })
            const stored = Refusal.storedRefusal(r)
            const back = Refusal.refusalFromStored(stored)
            if (back.origin !== r.origin || back.message !== r.message || back.code !== r.code) return false
            const parsed = Refusal.retryAfterHeader({
              get: (
                name
              ) => (name.toLowerCase() === "retry-after" && retryHeader._tag === "Some" ? retryHeader.value : null)
            })
            if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
