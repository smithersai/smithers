/**
 * `SuperviseRuntime` spells the run store's ownership shapes structurally so
 * the run store stays a dev dependency. These checks keep the two spellings
 * identical: a field the run store adds or renames fails the typecheck here.
 */
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import { describe, expectTypeOf, it } from "vitest"
import type * as SuperviseRuntime from "../src/SuperviseRuntime.ts"

type Evidence = Extract<SuperviseRuntime.Candidate, { readonly _tag: "stale-running" }>["livenessEvidence"]

describe("SuperviseRuntime ownership shapes", () => {
  it("matches the run store's LivenessEvidence", () => {
    expectTypeOf<Evidence>().toEqualTypeOf<LivenessEvidence>()
    expectTypeOf<
      Extract<SuperviseRuntime.Candidate, { readonly _tag: "stale-claim" }>["claimantDeathEvidence"]
    >().toEqualTypeOf<LivenessEvidence>()
  })

  it("matches the run store's OwnerId", () => {
    expectTypeOf<SuperviseRuntime.ResumeLease["claimant"]>().toEqualTypeOf<OwnerId>()
  })
})
