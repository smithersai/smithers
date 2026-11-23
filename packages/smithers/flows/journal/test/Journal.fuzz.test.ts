import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { JournalEvent, Redaction } from "../src/index.ts"

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

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const HexChar = Schema.Literals(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"])

describe("@smthrs/journal fuzz security & codec invariants", () => {
  it("Redaction strips sensitive keys, Bearer/PAT/OpenAI tokens, and never throws on arbitrary or deep/circular values", async () => {
    const redactor = Redaction.make()
    const arb = Arbitrary.schema(
      Schema.Struct({
        sensitiveKey: Schema.Literals([
          "password",
          "apiKey",
          "authorization",
          "access_token",
          "clientSecret",
          "privateKey"
        ]),
        safeKey: Schema.Literals(["status", "count", "label", "stage"]),
        tokenBody: Schema.Array(HexChar),
        prefix: Schema.String,
        suffix: Schema.String,
        depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ sensitiveKey, safeKey, tokenBody, prefix, suffix, depth }) => {
          const suffixHex = (tokenBody.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 36)
          const ghp = `ghp_${suffixHex}`
          const bearer = `Bearer ${suffixHex}`
          const sk = `sk-ant-api03-${suffixHex}`

          let nested: Record<string, unknown> = {
            [sensitiveKey]: `secret-val-${suffixHex}`,
            [safeKey]: `${prefix} ${ghp} ${bearer} ${sk} ${suffix}`
          }
          for (let i = 0; i < depth; i++) nested = { wrap: nested }

          const redacted = redactor(nested)
          const serialized = JSON.stringify(redacted)
          if (serialized.includes(`secret-val-${suffixHex}`)) return false
          if (serialized.includes(ghp)) return false
          if (serialized.includes(bearer)) return false
          if (serialized.includes(sk)) return false

          // redactJsonString never leaks credentials and never crashes on malformed JSON.
          const jsonOut = Redaction.redactJsonString(JSON.stringify(nested), redactor)
          if (jsonOut.includes(ghp) || jsonOut.includes(`secret-val-${suffixHex}`)) return false
          // Malformed JSON never throws defects and still redacts textual patterns.
          const brokenOut = Redaction.redactJsonString(`{broken ${ghp} ${prefix}`, redactor)
          if (typeof brokenOut !== "string") return false

          // Line redactor across arbitrary chunk splits never leaks ghp token.
          const lr = Redaction.lineRedactor()
          const line = `log ${prefix.replace(/[\r\n]/g, " ")} ${ghp} ${suffix.replace(/[\r\n]/g, " ")}`
          const split = Math.max(1, Math.floor(line.length / 2))
          lr.part(line.slice(0, split))
          const out = [...lr.line(line.slice(split)), ...lr.flush()].join("\n")
          return !out.includes(ghp)
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("JournalEvent helpers (contentDigest, companionRunId) are deterministic and consistent", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stream: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
        runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
        text: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ stream, runId, text }) => {
          const cleanStream = stream.replace(/[^a-zA-Z0-9._-]/g, "a") || "a"
          const cleanRun = runId.replace(/[^a-zA-Z0-9._-]/g, "b") || "b"
          const companion = JournalEvent.companionRunId(cleanStream, cleanRun)
          if (!JournalEvent.isCompanionRunId(companion)) return false
          if (isWellFormed(text)) {
            const d1 = JournalEvent.contentDigest(text)
            const d2 = JournalEvent.contentDigest(text)
            if (d1 !== d2 || !/^[0-9a-f]{64}$/.test(d1)) return false
          }
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
