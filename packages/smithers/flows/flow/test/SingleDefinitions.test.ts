/**
 * Every vocabulary this package speaks has ONE declaration, in `@smthrs/plan`.
 *
 * Identity, not equality: a structural copy of a literal union passes a
 * deep-equal check and still forks the moment one side gains a member. These
 * cases assert the same object, so a reintroduced copy fails here rather than
 * in a digest six packages away.
 */
import * as PlanCachePolicy from "@smthrs/plan/CachePolicy"
import * as Effects from "@smthrs/plan/Effects"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Node from "@smthrs/plan/Node"
import * as Plan from "@smthrs/plan/Plan"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Tier } from "../src/Action/Action.ts"
import { BoundaryMode } from "../src/Action/BoundaryMode.ts"
import * as CacheEnvironment from "../src/Action/CacheEnvironment.ts"
import * as Annotations from "../src/Flow/Annotations.ts"
import * as Flow from "../src/Flow/index.ts"

describe("single definitions", () => {
  it("takes the boundary mode from the plan file vocabulary", () => {
    expect(BoundaryMode).toBe(FileSet.BoundaryMode)
    expect(Plan.NodeEffects.fields.boundaryMode).toBe(FileSet.BoundaryMode)
    expect(BoundaryMode.literals).toEqual(["hard", "expected"])
  })

  it("takes the action tier from the plan effect taxonomy", () => {
    expect(Tier).toBe(Effects.Tier)
    expect(Tier.literals).toEqual(["sealed", "compensable", "irreversible"])
  })

  it("declares file effects with the plan node effect schema itself", () => {
    expect(Annotations.Effects).toBe(Plan.NodeEffects)
  })

  it("carries the effect envelope under the one annotation key", () => {
    expect(Annotations.EffectEnvelope).toBe(Effects.Envelope)
    expect(Annotations.EffectEnvelope.key).toBe("@smthrs/plan/Effects/Envelope")
  })

  it("names every flow call mode from the plan call vocabulary", () => {
    const Callee = Flow.make("single-definitions/callee", {
      payload: {},
      success: Schema.Number,
      body: () => Node.succeed(1)
    })
    const modeOf = (node: { readonly ast: Node.Ast }): unknown => (node.ast as { readonly mode?: unknown }).mode

    expect([modeOf(Callee.call({})), modeOf(Callee.child({})), modeOf(Callee.to({}))])
      .toEqual([...Node.CallMode.literals])
  })

  it("takes the whole cache policy from the plan declaration", () => {
    expect(CacheEnvironment.CacheScope).toBe(PlanCachePolicy.CacheScope)
    expect(CacheEnvironment.CachePolicy).toBe(PlanCachePolicy.CachePolicy)
    expect(CacheEnvironment.CachePolicyAnnotation).toBe(PlanCachePolicy.CachePolicyAnnotation)
    expect(CacheEnvironment.cachePolicyOf).toBe(PlanCachePolicy.cachePolicyOf)
    expect(CacheEnvironment.withCache).toBe(PlanCachePolicy.annotate)
    expect(CacheEnvironment.CacheScope.literals).toEqual(["run", "flow", "shared"])
  })

  it("keeps the identifier @smthrs/engine-store reads a dispatched policy by", () => {
    // Renaming it would make every policy already written invisible at
    // dispatch, so it is pinned on this side of the boundary too.
    expect(CacheEnvironment.CachePolicyAnnotation.key).toBe("@smthrs/flow/Action/CachePolicy")
  })

  it("keeps the file-effect declaration and the envelope apart", () => {
    // One key would be wrong: `EffectsDeclaration` says which files a node
    // touches, `EffectEnvelope` says how much it is allowed to touch.
    expect(Annotations.EffectsDeclaration.key).not.toBe(Annotations.EffectEnvelope.key)
  })
})
