import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Interactions, ViewCode, ViewCsp } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const ForbiddenSnippets = [
  "eval(\"1\")",
  "new Function(\"return 1\")()",
  "globalThis.fetch(\"https://evil.example\")",
  "window.location.href",
  "document.cookie",
  "process.env.SECRET",
  "fetch(\"https://evil.example\")",
  "import(\"node:fs\")",
  "({}).constructor.constructor(\"return this\")()",
  "Reflect.get(globalThis, \"process\")"
] as const

describe("@smthrs/views security fuzz invariants", () => {
  it("ViewCode.check ALWAYS refuses sandbox-escape payloads and never throws defects on arbitrary source", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        escapeIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: ForbiddenSnippets.length - 1 })),
        noise: Schema.String,
        raw: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ escapeIdx, noise, raw }) =>
          Effect.gen(function*() {
            const snippet = ForbiddenSnippets[escapeIdx]!
            const malicious =
              `import React from "react"\nexport default function View() { const x = ${snippet}; return <div>{String(x)}</div> }`
            const checked = yield* Effect.result(ViewCode.check(malicious, { components: ["Card"] }))
            if (Result.isSuccess(checked)) return false
            if (checked.failure._tag !== "@smthrs/views/ViewCodeError") return false

            // Disallowed module imports MUST ALWAYS fail closed.
            const badImport = `import x from ${
              JSON.stringify(noise.slice(0, 24) || "node:fs")
            }\nexport default function View() { return <div /> }`
            const badImportRes = yield* Effect.result(ViewCode.check(badImport, { components: ["Card"] }))
            if (
              Result.isSuccess(badImportRes) &&
              !ViewCode.modules.includes(noise.slice(0, 24) as (typeof ViewCode.modules)[number])
            ) {
              return false
            }

            // Arbitrary garbage source NEVER throws a defect.
            const arbitraryRes = yield* Effect.result(ViewCode.check(raw.slice(0, 512), { components: ["Card"] }))
            return Result.isSuccess(arbitraryRes) || arbitraryRes.failure._tag === "@smthrs/views/ViewCodeError"
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Interactions.parse and format round-trip valid events and never crash on arbitrary attributes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: Schema.Literals(["click", "submit", "select_item", "toggle-1", "a"]),
        arg: Schema.Union([Schema.Undefined, Schema.String]),
        garbage: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ name, arg, garbage }) => {
          const cleanArg = arg === undefined ? undefined : arg.slice(0, Interactions.maxArgLength)
          const ev = cleanArg === undefined ? { name } : { name, arg: cleanArg }
          const formatted = Interactions.format(ev as Interactions.Event)
          const parsed = Interactions.parse(formatted)
          if (Option.isNone(parsed)) return false
          if (parsed.value.name !== name || parsed.value.arg !== cleanArg) return false
          // Garbage input must cleanly return Option.some or Option.none without throwing.
          const g = Interactions.parse(garbage)
          return Option.isSome(g) || Option.isNone(g)
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ViewCsp.policy locks default-src none and ViewCsp.hash is deterministic sha256", async () => {
    const arb = Arbitrary.schema(Schema.String)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (script) => {
          if (!script.isWellFormed()) return true
          const h1 = ViewCsp.hash(script)
          const h2 = ViewCsp.hash(script)
          if (h1 !== h2 || !h1.startsWith("'sha256-") || !h1.endsWith("'")) return false
          const csp = ViewCsp.policy(h1)
          return csp.includes("default-src 'none'") && csp.includes("connect-src 'none'") &&
            csp.includes(`script-src ${h1}`)
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
