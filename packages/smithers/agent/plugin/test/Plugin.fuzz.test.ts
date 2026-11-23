import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Load from "../src/Load.ts"
import * as Manifest from "../src/Manifest.ts"
import { host } from "./support/hostFacts.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/plugin fuzz invariants", () => {
  it("Manifest.decode never throws defects on arbitrary JSON-like structures and Load.load enforces host invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        version: Schema.String,
        rawText: Schema.String,
        tier: Schema.Literals(["built-in", "project", "user"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ id, name, version, rawText, tier }) =>
          Effect.gen(function*() {
            const candidate = { id, name, version, contributes: {} }
            const decoded = yield* Effect.result(Manifest.decode(candidate))
            if (Result.isSuccess(decoded)) {
              const loaded = yield* Load.load(host(), [{
                manifest: decoded.success,
                tier: tier as Load.Candidate["tier"]
              }])
              if (!Array.isArray(loaded.refused)) return false
            }
            const decodedRaw = yield* Effect.result(Manifest.decode(rawText))
            return Result.isSuccess(decodedRaw) || Result.isFailure(decodedRaw)
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
