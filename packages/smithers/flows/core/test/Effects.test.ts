import * as PlanEffects from "@smthrs/plan/Effects"
import { describe, expect, it } from "vitest"
import * as Effects from "../src/Effects.ts"

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
})
