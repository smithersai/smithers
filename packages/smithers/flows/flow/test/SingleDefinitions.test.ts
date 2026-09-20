/**
 * Every vocabulary this package speaks has ONE declaration, in `@smthrs/plan`.
 *
 * Identity, not equality: a structural copy of a literal union passes a
 * deep-equal check and still forks the moment one side gains a member. These
 * cases assert the same object, so a reintroduced copy fails here rather than
 * in a digest six packages away.
 */
import * as Effects from "@smthrs/plan/Effects"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Plan from "@smthrs/plan/Plan"
import { describe, expect, it } from "vitest"
import { Tier } from "../src/Action/Action.ts"
import { BoundaryMode } from "../src/Action/BoundaryMode.ts"
import * as Annotations from "../src/Flow/Annotations.ts"

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

  it("keeps the file-effect declaration and the envelope apart", () => {
    // One key would be wrong: `EffectsDeclaration` says which files a node
    // touches, `EffectEnvelope` says how much it is allowed to touch.
    expect(Annotations.EffectsDeclaration.key).not.toBe(Annotations.EffectEnvelope.key)
  })
})
