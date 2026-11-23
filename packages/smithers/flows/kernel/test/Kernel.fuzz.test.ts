import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ChildProcessEnvironment, CommandLine } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/kernel security & command-line fuzz invariants", () => {
  it("ChildProcessEnvironment NEVER inherits credential-like ambient vars even if listed in names, returns null-proto, and respects undefined deletions", async () => {
    const secretPrefix = Schema.Literals(["OPENAI", "ANTHROPIC", "GITHUB", "AWS", "STRIPE", "CLOUDFLARE", "SMITHERS"])
    const secretSuffix = Schema.Literals(["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_CREDENTIAL", "_PRIVATE_KEY"])
    const safeName = Schema.Literals(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "SHELL"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        secretPrefix,
        secretSuffix,
        secretVal: Schema.String.pipe(Schema.check(Schema.isMinLength(4), Schema.isMaxLength(32))),
        safeName,
        safeVal: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        dropSafe: Schema.Boolean,
        extraName: Schema.Literals(["CUSTOM_VAR", "FOO_BAR"]),
        extraVal: Schema.String.pipe(Schema.check(Schema.isMaxLength(24)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secretPrefix, secretSuffix, secretVal, safeName, safeVal, dropSafe, extraName, extraVal }) =>
          Effect.sync(() => {
            const secretKey = `${secretPrefix}${secretSuffix}`
            const ambient: Record<string, string> = {
              [secretKey]: secretVal,
              [safeName]: safeVal,
              UNLISTED_AMBIENT: "must-not-leak"
            }
            const declared: Record<string, string | undefined> = {
              [extraName]: extraVal,
              ...(dropSafe ? { [safeName]: undefined } : {})
            }
            const env = ChildProcessEnvironment.make(ambient, declared, [
              ...ChildProcessEnvironment.inheritedNames,
              secretKey
            ])
            if (Object.getPrototypeOf(env) !== null) return false
            if (secretKey in env) return false
            if ("UNLISTED_AMBIENT" in env) return false
            if (dropSafe && safeName in env) return false
            if (!dropSafe && env[safeName] !== safeVal) return false
            if (env[extraName] !== extraVal) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("CommandLine.quote handles arbitrary strings safely without throwing and preserves non-empty tokens", async () => {
    const arb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(128))))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (token) =>
          Effect.sync(() => {
            const q = CommandLine.quote(token)
            if (typeof q !== "string" || q.length === 0) return false
            if (token === "" && q !== "''") return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
