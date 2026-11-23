import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Directive, Route } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/agent-fs Directive & Route fuzz invariants", () => {
  it("Directive.compile and Route.snapshot validate valid routes and reject traversal/relative-path/name-mismatch routes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        literal: Schema.Literals(["client", "local", "sandbox", "remote"]),
        seg: Schema.Literals(["alpha", "beta", ".", "..", "a/b"]),
        kind: Schema.Literals(["module", "markdown", "skill"]),
        relativeSource: Schema.Boolean,
        mismatchName: Schema.Boolean,
        modelInvocable: Schema.Boolean,
        mode: Schema.Literals(["hermetic", "expected"]),
        onConflict: Schema.Literals(["serialize", "lane", "fail"]),
        tier: Schema.Literals(["sealed", "compensable", "irreversible"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ literal, seg, kind, relativeSource, mismatchName, modelInvocable, mode, onConflict, tier }) =>
          Effect.gen(function*() {
            const placement = Directive.compile(literal)
            if (placement === undefined) return false
            const route = {
              name: mismatchName ? "wrong-name" : seg,
              segments: [seg],
              kind,
              sourcePath: relativeSource ? "relative/flow.ts" : `/flows/${seg}/flow.ts`,
              description: Option.some("fuzz"),
              input: { _tag: "None" },
              output: { _tag: "None" },
              capabilities: ["fs:read"],
              effects: { reads: [], writes: [], mode, onConflict, tier },
              modelInvocable,
              placement: Option.some(literal),
              ui: Option.none()
            } as unknown as Route.Route
            const snapRes = yield* Effect.result(Route.snapshot(route))
            const badSeg = seg === "." || seg === ".." || seg.includes("/")
            const shouldFail = badSeg || relativeSource || mismatchName
            if (shouldFail) return Result.isFailure(snapRes)
            if (Result.isFailure(snapRes)) return false
            const snap = snapRes.success
            if (snap.name !== seg || snap.kind !== kind) return false
            if (Route.isCommandRoute(snap) !== (kind === "module" && modelInvocable)) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
