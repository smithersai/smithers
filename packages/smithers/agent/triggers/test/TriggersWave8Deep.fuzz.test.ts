import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ClaimDecision from "../src/ClaimDecision.ts"
import { isReservation, reservationId, reservationLeaseMs } from "../src/TriggerStore.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "200")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261807")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/triggers Wave 8 deep fuzz (ClaimDecision.decide / lease / refuse across overlap policies & expired leases)", () => {
  it(
    "ClaimDecision.refuse, lease & decide uphold revision fencing, disabled refusal, expired reservation recovery & overlap modes",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          enabled: Schema.Boolean,
          revisionMatch: Schema.Boolean,
          overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
          activeKind: Schema.Literals(["none", "real-run", "fresh-res", "expired-res", "no-ts-res"]),
          existingKind: Schema.Literals(["none", "null-outcome", "buffered", "launched", "skipped"]),
          resumeBuffered: Schema.Boolean,
          sameOccurrence: Schema.Boolean,
          hasPending: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (v) =>
            Effect.sync(() => {
              const now = 1_700_000_000_000
              const occ = now
              const oldOcc = v.sameOccurrence ? occ : now - 60_000
              const resId = reservationId("trig-1", oldOcc, "r1")
              const activeRunId = v.activeKind === "none" ?
                undefined :
                v.activeKind === "real-run" ?
                "run-live-1" :
                resId
              const activeClaimedAt = v.activeKind === "fresh-res" ?
                now - 100 :
                v.activeKind === "expired-res" ?
                now - reservationLeaseMs - 1000 :
                v.activeKind === "real-run" ?
                now - 500 :
                undefined
              const existingFire: ClaimDecision.Fire | undefined = v.existingKind === "none" ?
                undefined :
                v.existingKind === "null-outcome" ?
                { outcome: null, runId: activeRunId } :
                v.existingKind === "buffered" ?
                { outcome: "buffered" } :
                v.existingKind === "launched" ?
                { outcome: "launched", runId: "run-prev" } :
                { outcome: "skipped" }

              const activeFire: ClaimDecision.Fire | undefined = activeRunId !== undefined && isReservation(activeRunId)
                ? { outcome: null, runId: "run-pred-1" }
                : undefined

              const snapshot: ClaimDecision.Snapshot = {
                enabled: v.enabled,
                revision: 5,
                overlap: v.overlap,
                activeRunId,
                activeClaimedAt,
                pending: v.hasPending ? now - 120_000 : undefined,
                existingFire,
                activeFire
              }
              const fire = {
                triggerId: "trig-1",
                occurrence: occ,
                expectedRevision: v.revisionMatch ? 5 : 4,
                resumeBuffered: v.resumeBuffered
              }

              const lease = ClaimDecision.lease({
                activeRunId,
                activeClaimedAt,
                now,
                pending: snapshot.pending,
                unfinished: activeFire
              })
              if (activeRunId === undefined) expect(lease._tag).toBe("Idle")
              else if (v.activeKind === "real-run" || v.activeKind === "fresh-res") expect(lease._tag).toBe("Held")
              else expect(lease._tag).toBe("Expired")

              const refused = ClaimDecision.refuse(snapshot, fire)
              if (!v.revisionMatch) expect(refused?.code).toBe("revision_mismatch")
              else if (!v.enabled) expect(refused?.code).toBe("trigger_disabled")
              else expect(refused).toBeUndefined()

              const dec = ClaimDecision.decide({
                snapshot,
                fire,
                claimedAt: now,
                reservationId: reservationId("trig-1", occ, "r2")
              })
              if (!v.revisionMatch || !v.enabled) {
                expect(dec._tag).toBe("Refused")
              } else {
                expect(dec._tag).toBe("Decided")
              }
              return true
            }),
          { seed, executions }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
