import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Shell from "../src/decompose/Shell.vibe"
import * as Expression from "../src/inventory/Expression.ts"
import * as Glob from "../src/inventory/Glob.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/ci parsers & evaluators fuzz", () => {
  it("Expression.evaluate, fill, and whole never throw on arbitrary strings", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        expr: Schema.String.check(Schema.isMaxLength(200)),
        val: Schema.String.check(Schema.isMaxLength(80))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ expr, val }) => {
          const scope: Expression.Scope = {
            context: (name) => (name === "env" ? { kind: "value", value: { foo: val, ok: true } } : undefined)
          }
          const evaluated = Expression.evaluate(expr, scope)
          if (typeof evaluated !== "object" || evaluated === null) return false
          const filled = Expression.fill(expr, scope)
          if (typeof filled !== "object" || filled === null) return false
          const whole = Expression.whole(expr)
          return whole === undefined || typeof whole === "string"
        },
        { executions, seed }
      )
    )
    assertPassed(report)
  })

  it("Glob.regexOf and Glob.filesOf never throw and always emit valid RegExp patterns", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(Schema.String.check(Schema.isMaxLength(120))).check(Schema.isMaxLength(6))
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (patterns) => {
          for (const p of patterns) {
            const re = Glob.regexOf(p)
            if (re !== undefined) {
              new RegExp(re)
            }
          }
          const files = Glob.filesOf(patterns)
          if (files !== undefined) {
            for (const re of [...files.take, ...files.leave]) {
              new RegExp(re)
            }
          }
          return true
        },
        { executions, seed }
      )
    )
    assertPassed(report)
  })

  it("Shell.commands never crashes and Shell.quote round-trips any word without command injection", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        script: Schema.String.check(Schema.isMaxLength(200)),
        word: Schema.String.check(Schema.isMaxLength(80))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ script, word }) => {
          const cmds = Shell.commands(script)
          if (cmds !== undefined && !Array.isArray(cmds)) return false
          if (!word.includes("\0") && !word.includes("\n") && !word.includes("\r")) {
            const quoted = Shell.quote(word)
            const parsed = Shell.commands(`echo ${quoted}`)
            if (parsed === undefined || parsed.length !== 1) return false
            if (parsed[0]?.words[0]?.text !== "echo" || parsed[0]?.words[1]?.text !== word) return false
          }
          return true
        },
        { executions, seed }
      )
    )
    assertPassed(report)
  })
})
