import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as UpdatePlan from "../src/UpdatePlan.vibe"

describe("UpdatePlan", () => {
  it("acknowledges with Codex's exact response text", async () => {
    const result = await Effect.runPromise(UpdatePlan.run({
      explanation: "kick off",
      plan: [
        { step: "read the code", status: "completed" },
        { step: "write the fix", status: "in_progress" },
        { step: "run the tests", status: "pending" }
      ]
    }))
    expect(result).toEqual({ output: "Plan updated" })
  })

  it("rejects unknown statuses at the schema boundary", () => {
    const decoded = Schema.decodeUnknownEffect(UpdatePlan.Input)({
      plan: [{ step: "x", status: "done" }]
    })
    expect(() => Effect.runSync(decoded)).toThrow()
  })

  // The description a model reads every frame ends with "At most one step can
  // be in_progress at a time." An invariant stated to the model and enforced
  // nowhere is a claim, not a rule.
  it.each(
    [
      { name: "an empty plan", plan: [] },
      { name: "all pending", plan: [{ step: "a", status: "pending" }, { step: "b", status: "pending" }] },
      { name: "all completed", plan: [{ step: "a", status: "completed" }, { step: "b", status: "completed" }] },
      {
        name: "exactly one in progress",
        plan: [{ step: "a", status: "in_progress" }, { step: "b", status: "pending" }]
      }
    ] as const
  )("accepts $name", async ({ plan }) => {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(UpdatePlan.Input)({ plan }))
    expect(decoded.plan).toHaveLength(plan.length)
    expect(await Effect.runPromise(UpdatePlan.run({ plan: [...plan] }))).toEqual({ output: "Plan updated" })
  })

  it("refuses a plan naming two steps in progress, at decode and at the handler", async () => {
    const plan = [
      { step: "a", status: "in_progress" },
      { step: "b", status: "in_progress" },
      { step: "c", status: "pending" }
    ] as const

    const decoded = await Effect.runPromise(
      Effect.exit(Schema.decodeUnknownEffect(UpdatePlan.Input)({ plan }))
    )
    expect(decoded._tag).toBe("Failure")

    // A host calling the handler directly never decodes, so the rule has to
    // hold at both entrances or it holds at neither.
    const applied = await Effect.runPromise(Effect.exit(UpdatePlan.run({ plan: [...plan] })))
    expect(applied._tag).toBe("Failure")
  })
})
