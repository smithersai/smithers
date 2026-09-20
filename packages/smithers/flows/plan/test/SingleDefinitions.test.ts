/**
 * The vocabularies this package owns are declared once inside it too.
 *
 * `Plan.PairStrategy` and `Effects.Declaration.onConflict` were the same three
 * literals in two files, and so were `KeyMaterial.kind` and
 * `Effects.Declaration.tier`. Identity, not equality: a structural copy passes
 * a deep-equal check and forks the moment one side gains a member.
 */
import { describe, expect, it } from "vitest"
import * as Effects from "../src/Effects.ts"
import * as FileSet from "../src/FileSet.ts"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as Plan from "../src/Plan.ts"

describe("single definitions", () => {
  it("resolves a write conflict with the one conflict vocabulary", () => {
    expect(Plan.PairStrategy).toBe(Effects.ConflictStrategy)
    expect(Effects.ConflictStrategy.literals).toEqual(["serialize", "lane", "fail"])
  })

  it("keys material with the one tier vocabulary", () => {
    expect(KeyMaterial.KeyMaterial.fields.kind).toBe(Effects.Tier)
    expect(Effects.Tier.literals).toEqual(["sealed", "compensable", "irreversible"])
  })

  it("declares the boundary mode once", () => {
    expect(Plan.NodeEffects.fields.boundaryMode).toBe(FileSet.BoundaryMode)
    expect(FileSet.BoundaryMode.literals).toEqual(["hard", "expected"])
  })

  it("publishes one envelope annotation key", () => {
    expect(Effects.Envelope.key).toBe("@smthrs/plan/Effects/Envelope")
  })
})
