import { Fuzz } from "@smthrs/fuzz"
import { describe, expect, test } from "bun:test"
import { Arbitrary, Effect, Schema } from "effect"
import * as Budget from "../src/budget.ts"
import * as Composer from "../src/composer.ts"
import * as Fuzzy from "../src/fuzzy.ts"
import * as Shell from "../src/shell.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const isSubsequence = (needle: string, haystack: string): boolean => {
  let at = 0
  for (const ch of needle) {
    const idx = haystack.indexOf(ch, at)
    if (idx < 0) return false
    at = idx + 1
  }
  return true
}

describe("apps/tui fuzzy, composer, shell & budget fuzz invariants", () => {
  test("Fuzzy.score & Fuzzy.filter preserve subsequence soundness, exact-match -100, non-mutation, and multi-token conjunction", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        query: Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        text: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        items: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(32)))).pipe(
          Schema.check(Schema.isMaxLength(16))
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ query, text, items }) =>
          Effect.sync(() => {
            const s = Fuzzy.score(query, text)
            const qLow = query.toLowerCase()
            const tLow = text.toLowerCase()
            if (qLow === "") {
              if (s !== 0) return false
            } else if (qLow === tLow) {
              if (s !== -100) return false
            } else {
              const sub = isSubsequence(qLow, tLow)
              if ((s !== undefined) !== sub) return false
              if (s !== undefined && !Number.isFinite(s)) return false
            }

            const snapshot = [...items]
            const filtered = Fuzzy.filter(items, query, (x) => x)
            // Never mutates input
            if (items.length !== snapshot.length || items.some((v, i) => v !== snapshot[i])) return false
            // Empty/whitespace/slash query preserves exact order
            const tokens = query.split(/[\s/]+/).filter((t) => t !== "")
            if (tokens.length === 0) {
              return filtered.length === items.length && filtered.every((v, i) => v === items[i])
            }
            // Every returned element must match EVERY token
            for (const item of filtered) {
              for (const tok of tokens) {
                if (Fuzzy.score(tok, item) === undefined) return false
              }
            }
            // Every matching element must be present (completeness)
            const expectedCount = items.filter((it) => tokens.every((tok) => Fuzzy.score(tok, it) !== undefined)).length
            return filtered.length === expectedCount
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  test("Composer.route & Shell.parse/tail/persisted uphold routing precedence, UTF-8 byte/line bounds, and excluded output stripping", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: Schema.Literals(["", "!", "!!", "/", "hello "]),
        body: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        steering: Schema.Boolean,
        lines: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2100 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prefix, body, steering, lines }) =>
          Effect.sync(() => {
            const text = `${prefix}${body}`
            const r = Composer.route(text, steering)
            if (text.startsWith("!!")) {
              if (r._tag !== "shell" || !r.excluded) return false
            } else if (text.startsWith("!")) {
              if (r._tag !== "shell" || r.excluded) return false
            } else if (text.startsWith("/")) {
              if (r._tag !== "command") return false
            } else if (steering) {
              if (r._tag !== "steer") return false
            } else {
              if (r._tag !== "prompt") return false
            }

            // Excluded shell results MUST never persist output or fullOutputPath
            const res: Shell.Result = {
              command: body,
              output: "secret-output",
              exitCode: 0,
              cancelled: false,
              fullOutputPath: "/tmp/secret.log"
            }
            const keptExcluded = Shell.persisted(res, true)
            if (keptExcluded.output !== "" || keptExcluded.fullOutputPath !== undefined) return false

            // Shell.tail strictly obeys maxLines & maxBytes
            const big = lines > 0 ? "x\n".repeat(Math.min(lines, 2050)) : body
            const cut = Shell.tail(big)
            if (cut.text.split("\n").length > Shell.maxLines) return false
            if (Buffer.byteLength(cut.text, "utf8") > Shell.maxBytes) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  test("Budget.policy never throws on arbitrary env/flag inputs and rejects negative/non-numeric caps", async () => {
    const valArb = Schema.OptionFromUndefinedOr(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        Schema.Literals(["0", "-5", "off", "unlimited", "1000000", "200M", "NaN", "1.5"])
      ])
    )
    const arb = Arbitrary.schema(
      Schema.Struct({
        envRun: valArb,
        envDaily: valArb,
        flagRun: valArb,
        flagDaily: valArb
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ envRun, envDaily, flagRun, flagDaily }) =>
          Effect.sync(() => {
            const p = Budget.policy(
              {
                [Budget.environmentKey]: envRun._tag === "Some" ? envRun.value : undefined,
                [Budget.dailyEnvironmentKey]: envDaily._tag === "Some" ? envDaily.value : undefined
              },
              {
                tokens: flagRun._tag === "Some" ? flagRun.value : undefined,
                daily: flagDaily._tag === "Some" ? flagDaily.value : undefined
              }
            )
            if (p === undefined) return true
            if ("error" in p) return typeof p.error === "string" && p.error.length > 0
            if (p.tokens !== undefined && (!Number.isInteger(p.tokens.max) || p.tokens.max <= 0)) return false
            if (p.daily !== undefined && (!Number.isInteger(p.daily.max) || p.daily.max <= 0)) return false
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
