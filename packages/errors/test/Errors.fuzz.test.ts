import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  hasSmithersErrorShape,
  isSmithersError,
  isSmithersErrorCode,
  SmithersError,
  smithersErrorCodes,
  smithersErrorDefinitions
} from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/errors comprehensive fuzz invariants", () => {
  it("constructs every SmithersErrorCode with/without details, cause, includeDocsUrl, and trailing docs suffix deduplication", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        codeIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: smithersErrorCodes.length - 1 }))
        ),
        summary: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals([
            "",
            "   ",
            `boom See ${ERROR_REFERENCE_URL}`,
            `boom See ${ERROR_REFERENCE_URL}  See ${ERROR_REFERENCE_URL}  `
          ])
        ]),
        withDetails: Schema.Boolean,
        withCause: Schema.Boolean,
        includeDocsUrl: Schema.Boolean,
        detailVal: Schema.String.pipe(Schema.check(Schema.isMaxLength(24)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ codeIdx, summary, withDetails, withCause, includeDocsUrl, detailVal }) =>
          Effect.sync(() => {
            const code = smithersErrorCodes[codeIdx]!
            if (!isSmithersErrorCode(code)) return false
            if (
              smithersErrorDefinitions[code] === undefined || getSmithersErrorDefinition(code) === undefined
            ) return false

            const detailsInput = withDetails ? { k: detailVal } : undefined
            const causeVal = withCause ? new Error("root") : undefined
            const err = new SmithersError(code, summary, detailsInput, {
              includeDocsUrl,
              cause: causeVal
            })

            if (!isSmithersError(err) || !hasSmithersErrorShape(err)) return false
            if (err.code !== code || err.docsUrl !== ERROR_REFERENCE_URL) return false
            if (withDetails) {
              if (!Object.isFrozen(err.details) || err.details?.["k"] !== detailVal) return false
              detailsInput!["k"] = "mutated"
              if (err.details?.["k"] !== detailVal) return false
            } else if ("details" in err) {
              return false
            }
            if (withCause && err.cause !== causeVal) return false
            if (!withCause && Object.hasOwn(err, "cause")) return false

            const json = err.toJSON()
            if (json["code"] !== code) return false
            // Idempotent re-wrapping of err.message must never double-append docsUrl
            const rewrapped = new SmithersError(code, err.message)
            if (rewrapped.summary !== err.summary) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("isSmithersError, isSmithersErrorCode, and hasSmithersErrorShape reject non-errors and throwing getters cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.Null,
        Schema.Boolean,
        Schema.Number,
        Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(8)))).pipe(Schema.check(Schema.isMaxLength(3))),
        Schema.Struct({
          _tag: Schema.Literals(["SmithersError", "Other"]),
          code: Schema.String,
          message: Schema.String
        })
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (value) =>
          Effect.sync(() => {
            if (isSmithersError(value)) return false
            if (typeof value === "string") {
              const expected = (smithersErrorCodes as ReadonlyArray<string>).includes(value)
              if (isSmithersErrorCode(value) !== expected) return false
            } else {
              if (isSmithersErrorCode(value)) return false
            }
            // Throwing getter must never crash hasSmithersErrorShape
            const trap = Object.defineProperty(new Error("trap"), "details", {
              get() {
                throw new Error("getter trap")
              }
            })
            if (hasSmithersErrorShape(trap)) return false
            // Valid structural shape passes hasSmithersErrorShape
            const validShape = Object.assign(new Error("msg"), {
              code: smithersErrorCodes[0]!,
              summary: "msg",
              docsUrl: ERROR_REFERENCE_URL
            })
            if (!hasSmithersErrorShape(validShape)) return false
            return typeof hasSmithersErrorShape(value) === "boolean"
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
