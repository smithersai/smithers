import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Scheduling } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/plan Scheduling fuzz invariants", () => {
  it("Scheduling.make never admits candidates past steps or agents caps and conserves all candidates", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        maxSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        maxAgents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        runningSteps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        runningAgents: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        kinds: Schema.Array(Schema.Literals(["step", "agent", "merge"]))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ maxSteps, maxAgents, runningSteps, runningAgents, kinds }) => {
          const policy = Scheduling.make({ steps: maxSteps, agents: maxAgents })
          const candidates: ReadonlyArray<
            Scheduling.Candidate<
              { readonly id: string; readonly kind: "step" | "agent" | "merge"; readonly priority: number }
            >
          > = kinds.slice(0, 12).map((kind, i) => ({
            node: { id: `n${i}`, kind, priority: i % 3 },
            order: i,
            waited: i % 4
          }))
          const agents = Math.min(runningAgents, runningSteps)
          const usage: Scheduling.Usage = { steps: runningSteps, agents }
          const admission = policy.admit(candidates, usage)
          const admittedSteps = runningSteps + admission.admitted.length
          const admittedAgents = agents + admission.admitted.filter((c) => c.node.kind === "agent").length
          if (runningSteps >= maxSteps && admission.admitted.length !== 0) return false
          if (runningSteps < maxSteps && admittedSteps > maxSteps) return false
          if (agents < maxAgents && admittedAgents > maxAgents) return false
          // Conservation: admitted + deferred === candidates.
          return admission.admitted.length + admission.deferred.length === candidates.length
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
