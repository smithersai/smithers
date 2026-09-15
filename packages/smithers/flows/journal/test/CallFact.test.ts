import { Context, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CallFact } from "../src/index.ts"

describe("native call fact contract", () => {
  it("names public logical run coordinates, validates stable IDs and carries a data-only action annotation", () => {
    const identity = { runId: "control-run", frame: 2, cell: "cell", ordinal: 3, declaration: "d", layers: ["base"] }
    const call = { callId: `cell-call-v1:${"a".repeat(64)}`, identity, flowName: "write", input: { path: "a" } }
    expect(Schema.is(CallFact.Identity)(identity)).toBe(true)
    expect(Schema.is(CallFact.Identity)({ ...identity, ordinal: -1 })).toBe(false)
    expect(Schema.is(CallFact.Call)(call)).toBe(true)
    expect(Schema.is(CallFact.Call)({ ...call, callId: "guessed" })).toBe(false)
    const annotation = { phase: "invoked" as const, call }
    expect(Context.get(Context.make(CallFact.Annotation, annotation), CallFact.Annotation)).toEqual(annotation)
    expect(Schema.is(CallFact.Fact)({ version: 1, phase: "invoked", ...call })).toBe(true)
    expect(Schema.is(CallFact.Fact)({ version: 2, phase: "invoked", ...call })).toBe(false)
    const result = { outcome: "failure", value: null, message: "deadline", code: "timeout" }
    expect(Schema.is(CallFact.Result)(result)).toBe(true)
    expect(
      Schema.is(CallFact.Fact)({
        version: 1,
        phase: "settled",
        callId: call.callId,
        identity,
        flowName: "write",
        ...result
      })
    ).toBe(true)
    expect(CallFact.eventType).toBe("flows.harness.call-fact.v1")
  })
})
