import { describe, expect, it } from "@effect/vitest"
import type { Action } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as Admission from "../src/internal/CacheAdmission.ts"
import type * as StepBoundary from "../src/StepBoundary.vibe"

const hard: FileBoundary = { boundaryMode: "hard", readSet: [], writeSet: ["output.txt"] }
const declarations: ReadonlyArray<FileBoundary | undefined> = [
  undefined,
  { ...hard, boundaryMode: "expected" },
  { ...hard, readSet: [{ _tag: "Glob", include: ["src/**"] }] },
  hard
]
const tiers: ReadonlyArray<Action.Tier> = ["sealed", "compensable", "irreversible"]
const complete: StepBoundary.BoundaryEvidence = {
  declaredOutputs: { output: "artifact" },
  diffIdentity: "diff",
  wholeTreeWritesVerified: true,
  hermeticReadsVerified: true
}
const eligible = Admission.declaration({ tier: "sealed", metadata: hard })

describe("phase-specific cache admission", () => {
  it("admits nonempty exact read declarations without treating them as unresolved globs", () => {
    const metadata: FileBoundary = { ...hard, readSet: [{ path: "input.txt", digest: "measured-digest" }] }
    expect(Admission.declaration({ tier: "sealed", metadata })).toEqual({ _tag: "Eligible", metadata })
  })

  it("classifies declaration tiers and exact versus unresolved boundary reads", () => {
    for (const tier of tiers) {
      for (const metadata of declarations) {
        const result = Admission.declaration({ tier, metadata })
        const reason = tier !== "sealed" ? "unsealed" : metadata === undefined ?
          "missing-boundary"
          : metadata.boundaryMode !== "hard" ?
          "expected-boundary"
          : metadata.readSet.length > 0
          ? "unresolved-read-glob"
          : undefined
        expect(result).toEqual(reason === undefined ? { _tag: "Eligible", metadata } : { _tag: "Disabled", reason })
      }
    }
  })

  it("preserves the existing evidence truth table for candidates and both completion paths", () => {
    // These predicates are the former independent gates, not calls to the new
    // classifier. Current host read checks are intentionally not represented
    // by the historical flag: a candidate must be remeasured before replay.
    for (const tier of tiers) {
      for (const writes of [undefined, true] as const) {
        for (const reads of [undefined, true] as const) {
          for (const recordedReads of [undefined, true] as const) {
            for (
              const deviation of [undefined, {
                _tag: "ExpectedSetDeviation" as const,
                paths: ["outside.txt"],
                diffIdentity: "diff"
              }]
            ) {
              const meta = {
                tier,
                readSetVerified: recordedReads,
                boundary: {
                  ...complete,
                  wholeTreeWritesVerified: writes,
                  hermeticReadsVerified: reads,
                  deviation
                },
                provenance: "preserve-this-object"
              }
              const expectedCandidate = tier === "sealed" && deviation === undefined && writes === true &&
                reads === true
              expect(Admission.candidate(meta)._tag === "CandidateEvidence").toBe(expectedCandidate)
              for (const declaration of [eligible, Admission.declaration({ tier: "irreversible", metadata: hard })]) {
                for (const quarantined of [false, true]) {
                  const decision = Admission.completion(declaration, meta, quarantined)
                  const expectedPublish = declaration._tag === "Eligible" && !quarantined && expectedCandidate &&
                    recordedReads === true
                  expect(decision._tag === "PublishCompletion").toBe(expectedPublish)
                  if (decision._tag === "PublishCompletion") expect(decision.meta).toBe(meta)
                }
              }
            }
          }
        }
      }
    }
  })

  it("keeps refusal reasons precise without promoting malformed or incomplete metadata", () => {
    const cases: ReadonlyArray<readonly [Admission.Metadata | undefined, Admission.Refused["reason"]]> = [
      [undefined, "invalid-meta"],
      [{ tier: "compensable", boundary: complete }, "unsealed-meta"],
      [{ tier: "sealed" }, "missing-evidence"],
      [{
        tier: "sealed",
        boundary: {
          ...complete,
          deviation: {
            _tag: "MissingDeclaredOutput",
            paths: ["output.txt"],
            diffIdentity: "diff"
          }
        }
      }, "deviation"],
      [{ tier: "sealed", boundary: { ...complete, wholeTreeWritesVerified: undefined } }, "unverified-writes"],
      [{ tier: "sealed", boundary: { ...complete, hermeticReadsVerified: undefined } }, "unverified-hermetic-reads"]
    ]
    for (const [meta, reason] of cases) {
      expect(Admission.candidate(meta)).toEqual({ _tag: "Refused", reason })
      expect(Admission.completion(eligible, meta, false)).toEqual({ _tag: "Refused", reason })
    }
  })

  it("allows remeasurement of historical candidate reads but forbids publishing an unverified completion", () => {
    const meta = { tier: "sealed" as const, boundary: complete }
    expect(Admission.candidate(meta)).toEqual({ _tag: "CandidateEvidence", meta, evidence: complete })
    expect(Admission.completion(eligible, meta, false)).toEqual({
      _tag: "Refused",
      reason: "unverified-recorded-reads"
    })
    expect(Admission.completion(eligible, { ...meta, readSetVerified: true }, true)).toEqual({
      _tag: "Refused",
      reason: "quarantined-evidence"
    })
    // Publication remains a gate on an already decoded metadata object. Do not
    // mutate it or replace its provenance when fresh and durable paths converge.
    const verified = { ...meta, readSetVerified: true as const }
    expect(Admission.completion(eligible, verified, false)).toEqual({ _tag: "PublishCompletion", meta: verified })
  })
})
