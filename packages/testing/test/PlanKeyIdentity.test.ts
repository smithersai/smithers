import * as Digest from "@smthrs/core/Digest"
import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Plan from "../src/Plan.ts"

// `Plan.keys` derives two different identities, and the reference documents
// both. Sealed material is keyed the way the persisted plan keys it. Every
// other tier is keyed as the run-local ordinal the engine dispatches under,
// which `Plan.compile`'s `StepKey.planIdentity` fingerprint deliberately does
// not reproduce: that one keys a non-sealed tier in the `plan-declaration`
// namespace, independently of any run.

const graphOf = (tier: "sealed" | "compensable"): Graph.Graph =>
  Graph.build(
    Action.make("recorded:reviewer", { payload: Schema.Struct({}), success: Schema.String, tier })
      .annotate(Flow.EffectsDeclaration, {
        reads: ["workspace/pr.json"],
        writes: ["workspace/review.json"],
        boundaryMode: "hard"
      })
      .call({})
  )

/** The draft of the given tier, with the ordinal position `keys` gives it. */
const declarationOf = (graph: Graph.Graph, kind: string) => {
  const drafts = Graph.drafts(graph)
  const ordinal = drafts.findIndex((draft) => draft.material.kind === kind)
  expect(ordinal).toBeGreaterThanOrEqual(0)
  return { draft: drafts[ordinal]!, ordinal }
}

const runKey = <A, E>(effect: Effect.Effect<A, E, import("effect/Crypto").Crypto>): A =>
  Effect.runSync(Digest.provideSync(effect))

describe("plan key identity", () => {
  it("keys sealed material the way the persisted plan keys it", () => {
    const graph = graphOf("sealed")
    const { draft } = declarationOf(graph, "sealed")
    expect(Plan.keys(graph)[draft.id]).toBe(runKey(StepKey.planIdentity(draft.material, {})))
  })

  it("keys non-sealed material as a run-local ordinal, not a plan fingerprint", () => {
    const graph = graphOf("compensable")
    const { draft, ordinal } = declarationOf(graph, "compensable")
    const key = Plan.keys(graph, { runId: "identity-test" })[draft.id]
    expect(key).toBe(runKey(StepKey.ordinal({
      runId: "identity-test",
      parentScope: draft.id,
      ordinal,
      tier: "compensable"
    })))
    expect(key).not.toBe(runKey(StepKey.planIdentity(draft.material, {})))
  })
})
