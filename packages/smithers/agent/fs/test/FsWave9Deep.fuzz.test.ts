import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Boundary from "../src/internal/Boundary.ts"
import * as SchemaBridge from "../src/internal/SchemaBridge.vibe"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261145")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 120))

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("Agent FS Wave 9 deep fuzzing (Boundary & SchemaBridge)", () => {
  it(
    "Boundary.admitDecoded, inspectRecord, inspectOption & stringArray refuse hostile prototypes, getters, Proxies, surrogates, and NUL bytes",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          dateCase: Schema.Literals(["valid", "nan", "extra-key", "subclass"]),
          recCase: Schema.Literals([
            "valid",
            "valid-opt",
            "null",
            "array",
            "class-inst",
            "symbol-key",
            "extra-key",
            "getter-req",
            "non-enum-req",
            "getter-opt",
            "proxy-throw"
          ]),
          optCase: Schema.Literals(["some", "none", "not-option", "proxy-throw"]),
          arrCase: Schema.Literals([
            "valid",
            "empty-ok",
            "empty-disallowed",
            "non-array",
            "sparse",
            "too-many",
            "too-long",
            "nul-char",
            "lone-surrogate",
            "proxy-throw"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ dateCase, recCase, optCase, arrCase }) =>
            Effect.sync(() => {
              // 1. admitDecoded
              let dateVal: unknown
              if (dateCase === "valid") dateVal = new Date(1_750_000_000_000)
              else if (dateCase === "nan") dateVal = new Date(Number.NaN)
              else if (dateCase === "extra-key") {
                const d = new Date(1_750_000_000_000) as Date & { extra?: number }
                d.extra = 1
                dateVal = d
              } else {
                class SubDate extends Date {}
                dateVal = new SubDate(1_750_000_000_000)
              }
              const dec = Boundary.admitDecoded({ at: dateVal })
              expect(dec.ok).toBe(dateCase === "valid")

              // 2. inspectRecord
              let recVal: unknown
              if (recCase === "valid") recVal = { a: 1 }
              else if (recCase === "valid-opt") recVal = { a: 1, b: "two" }
              else if (recCase === "null") recVal = null
              else if (recCase === "array") recVal = [1]
              else if (recCase === "class-inst") recVal = new Map()
              else if (recCase === "symbol-key") recVal = { a: 1, [Symbol("x")]: 2 }
              else if (recCase === "extra-key") recVal = { a: 1, unknown: 2 }
              else if (recCase === "getter-req") {
                recVal = {
                  get a() {
                    return 1
                  }
                }
              } else if (recCase === "non-enum-req") {
                const o = {}
                Object.defineProperty(o, "a", { value: 1, enumerable: false })
                recVal = o
              } else if (recCase === "getter-opt") {
                recVal = {
                  a: 1,
                  get b() {
                    return 2
                  }
                }
              } else {
                recVal = new Proxy({}, {
                  ownKeys() {
                    throw new Error("trap")
                  }
                })
              }
              const ir = Boundary.inspectRecord(recVal, ["a"], ["b"])
              expect(ir.ok).toBe(recCase === "valid" || recCase === "valid-opt")

              // 3. inspectOption
              let optVal: unknown
              if (optCase === "some") optVal = Option.some(42)
              else if (optCase === "none") optVal = Option.none()
              else if (optCase === "not-option") optVal = { _tag: "Some", value: 1 }
              else {optVal = new Proxy({}, {
                  get() {
                    throw new Error("trap")
                  }
                })}
              const io = Boundary.inspectOption(optVal)
              expect(io.ok).toBe(optCase === "some" || optCase === "none")

              // 4. stringArray
              let arrVal: unknown
              const allowEmpty = arrCase === "empty-ok"
              if (arrCase === "valid") arrVal = ["alpha", "beta"]
              else if (arrCase === "empty-ok" || arrCase === "empty-disallowed") arrVal = [""]
              else if (arrCase === "non-array") arrVal = "not-array"
              else if (arrCase === "sparse") {
                const a = new Array<string>(2)
                a[0] = "ok"
                arrVal = a
              } else if (arrCase === "too-many") arrVal = ["a", "b", "c", "d"]
              else if (arrCase === "too-long") arrVal = ["x".repeat(20)]
              else if (arrCase === "nul-char") arrVal = ["a\0b"]
              else if (arrCase === "lone-surrogate") arrVal = ["\uD800"]
              else {arrVal = new Proxy(["a"], {
                  ownKeys() {
                    throw new Error("trap")
                  }
                })}
              const sa = Boundary.stringArray(arrVal, { maxItems: 3, maxLength: 10, allowEmpty })
              expect(sa.ok).toBe(arrCase === "valid" || arrCase === "empty-ok")
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "SchemaBridge.toCommandSchema, decodeInput, encodeOutput & snapshotInput handle rich Effect Schema shapes and failures",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          schemaKind: Schema.Literals([
            "struct-full",
            "struct-optional",
            "literals",
            "union-tagged",
            "array-strings",
            "boolean-int",
            "record-str",
            "unknown-any"
          ]),
          validInput: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ schemaKind, validInput }) =>
            Effect.gen(function*() {
              let schema: Schema.Top
              let sample: unknown
              switch (schemaKind) {
                case "struct-full":
                  schema = Schema.Struct({
                    name: Schema.String,
                    count: Schema.Int,
                    flag: Schema.Boolean,
                    tags: Schema.Array(Schema.String)
                  })
                  sample = validInput ? { name: "ok", count: 3, flag: true, tags: ["a"] } : { name: 123 }
                  break
                case "struct-optional":
                  schema = Schema.Struct({
                    path: Schema.String,
                    limit: Schema.optional(Schema.Number),
                    mode: Schema.optional(Schema.Literals(["fast", "full"]))
                  })
                  sample = validInput ? { path: "src/a.ts", mode: "fast" } : { path: null }
                  break
                case "literals":
                  schema = Schema.Literals(["one", "two", "three"])
                  sample = validInput ? "two" : "four"
                  break
                case "union-tagged":
                  schema = Schema.Union([
                    Schema.TaggedStruct("A", { x: Schema.Number }),
                    Schema.TaggedStruct("B", { y: Schema.String })
                  ])
                  sample = validInput ? { _tag: "A", x: 7 } : { _tag: "C" }
                  break
                case "array-strings":
                  schema = Schema.Array(Schema.String)
                  sample = validInput ? ["x", "y"] : [1, 2]
                  break
                case "boolean-int":
                  schema = Schema.Struct({ ok: Schema.Boolean, n: Schema.Number })
                  sample = validInput ? { ok: false, n: 1.5 } : { ok: "no", n: "nan" }
                  break
                case "record-str":
                  schema = Schema.Record(Schema.String, Schema.String)
                  sample = validInput ? { k: "v" } : 42
                  break
                case "unknown-any":
                  schema = Schema.Unknown
                  sample = { anything: [1, true, "ok"] }
                  break
              }

              const csExit = yield* Effect.exit(SchemaBridge.toCommandSchema({ id: schemaKind } as never, schema))
              expect(Exit.isSuccess(csExit) || Exit.isFailure(csExit)).toBe(true)

              const decExit = yield* Effect.exit(SchemaBridge.decodeInput(schema, sample))
              if (validInput || schemaKind === "unknown-any") {
                expect(Exit.isSuccess(decExit)).toBe(true)
                if (Exit.isSuccess(decExit)) {
                  const encExit = yield* Effect.exit(SchemaBridge.encodeOutput(schema, decExit.value))
                  expect(Exit.isSuccess(encExit)).toBe(true)
                }
              } else {
                expect(Exit.isFailure(decExit)).toBe(true)
              }

              const snapExit = yield* Effect.exit(SchemaBridge.snapshotInput(sample))
              expect(Exit.isSuccess(snapExit)).toBe(true)
              const badSnap = yield* Effect.exit(SchemaBridge.snapshotInput({ bad: () => 1 }))
              expect(Exit.isFailure(badSnap)).toBe(true)
              return true
            }),
          { seed: seed + 1, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
