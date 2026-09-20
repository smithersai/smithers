import * as PlanEffects from "@smthrs/plan/Effects"
import * as PlanKeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import type * as KeyMaterial from "../src/KeyMaterial.ts"

describe("Effects", () => {
  it("is the single model, re-exported rather than reimplemented", () => {
    expect(Effects.make).toBe(PlanEffects.make)
    expect(Effects.covers).toBe(PlanEffects.covers)
    expect(Effects.narrow).toBe(PlanEffects.narrow)
    expect(Effects.overlaps).toBe(PlanEffects.overlaps)
    expect(Effects.sealed).toBe(PlanEffects.sealed)
  })

  it("publishes the declaration API and keeps the matching internals off it", () => {
    expect(Object.keys(Effects).sort()).toEqual(["covers", "make", "narrow", "overlaps", "sealed"])
  })

  it("annotates an envelope under the one key, not a second key of its own", () => {
    // `@smthrs/flow` publishes the same object as `Flow.EffectEnvelope`. While
    // the two packages each declared a key, a flow annotated for one graph
    // builder was invisible to the other.
    expect(Annotations.Effects).toBe(PlanEffects.Envelope)
    expect(Annotations.Effects.key).toBe("@smthrs/plan/Effects/Envelope")
  })

  it("names key material with the plan declaration, narrowed where its graph is stricter", () => {
    const material: KeyMaterial.KeyMaterial = {
      version: PlanKeyMaterial.version,
      kind: "sealed",
      body: { action: "compile" },
      inputs: [{ _tag: "Ref", from: "read", path: [] }],
      layers: [],
      capabilities: [],
      effects: Effects.make({ reads: [], writes: ["dist"], mode: "hermetic", onConflict: "serialize" }),
      placement: undefined
    }
    // The version literal is plan's constant, not a second copy of the string.
    expect(material.version).toBe(PlanKeyMaterial.version)
    expect(PlanKeyMaterial.version).toBe("flows/key-material/v2")
    // The plan schema admits what this package's graph builds, which is what
    // makes the narrowing above a narrowing rather than a second shape.
    expect(Schema.is(PlanKeyMaterial.KeyMaterial)(material)).toBe(true)
    expect(PlanKeyMaterial.dependencies(material)).toEqual(["read"])
  })
})
