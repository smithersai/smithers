/**
 * Invariants of the pure queue state under arbitrary admission and promotion
 * sequences.
 *
 * The example-based cases in `NotificationState.test.ts` pin the transitions a
 * reader is expected to reason about. These check the laws that must hold for
 * every sequence: the bound is never exceeded, admission order survives every
 * transition, and a promotion takes exactly what it reports and leaves the
 * rest. They are written as laws rather than as a second implementation, so a
 * mistake made twice cannot pass them.
 */
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationState from "../src/NotificationState.ts"

const params = {
  numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100),
  ...(process.env["FC_SEED"] === undefined ? {} : { seed: Number(process.env["FC_SEED"]) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const lineages = ["run/root", "run/root/child"] as const

interface Admit {
  readonly op: "admit"
  readonly tag: "human-steer" | "human-followup" | "system-event"
  readonly lineage: string
  readonly key: string | undefined
}

interface Promote {
  readonly op: "steers" | "queued"
  readonly lineage: string | undefined
  readonly cutoffBack: number
}

type Operation = Admit | Promote

const admitArbitrary: FastCheck.Arbitrary<Admit> = FastCheck.record({
  op: FastCheck.constant("admit" as const),
  tag: FastCheck.constantFrom("human-steer" as const, "human-followup" as const, "system-event" as const),
  lineage: FastCheck.constantFrom(...lineages),
  key: FastCheck.option(FastCheck.constantFrom("alpha", "beta"), { nil: undefined })
})

const promoteArbitrary: FastCheck.Arbitrary<Promote> = FastCheck.record({
  op: FastCheck.constantFrom("steers" as const, "queued" as const),
  lineage: FastCheck.option(FastCheck.constantFrom(...lineages), { nil: undefined }),
  cutoffBack: FastCheck.integer({ min: 0, max: 4 })
})

const operations = FastCheck.array(FastCheck.oneof(admitArbitrary, admitArbitrary, promoteArbitrary), {
  minLength: 1,
  maxLength: 40
})

const notification = (admit: Admit, seq: number): Notification => {
  const common = {
    id: `n-${seq}`,
    targetLineageId: admit.lineage,
    provenance: {
      sourceRunId: "operator",
      sourceLineageId: "operator/root",
      sourceTurn: 0,
      sourceActor: "human:will"
    },
    payload: { seq }
  }
  if (admit.tag === "human-steer") return { _tag: "human-steer", delivery: "steer", ...common }
  if (admit.tag === "human-followup") return { _tag: "human-followup", delivery: "queue", ...common }
  return {
    _tag: "system-event",
    delivery: "queue",
    ...common,
    ...(admit.key === undefined ? {} : { coalescingKey: admit.key })
  }
}

const ids = (state: NotificationState.State): ReadonlyArray<string> => state.items.map((item) => item.notification.id)

describe("NotificationState laws", () => {
  it("never exceeds the bound, and never reorders what it retains", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: 1, max: 8 }), operations, (capacity, script) => {
        let state = NotificationState.empty(capacity)
        let seq = 0
        for (const operation of script) {
          const before = state
          if (operation.op === "admit") {
            seq += 1
            const admission = NotificationState.admit(before, notification(operation, seq), seq)
            state = admission.state
            if (admission.decision === "admitted") {
              expect(state.items.length).toBe(before.items.length + 1)
              expect(ids(state)).toEqual([...ids(before), `n-${seq}`])
            } else if (admission.decision === "coalesced") {
              expect(state.items.length).toBe(before.items.length)
            } else {
              // A refusal retains nothing and changes nothing.
              expect(state).toBe(before)
              expect(before.items.length).toBe(capacity)
            }
          } else {
            const cutoff = Math.max(0, seq - operation.cutoffBack)
            const promotion = operation.op === "steers"
              ? NotificationState.promoteSteers(before, cutoff, operation.lineage)
              : NotificationState.promoteQueued(before, operation.lineage)
            state = promotion.state
            const promoted = promotion.promoted.map((item) => item.notification.id)
            // What a boundary reports it took is exactly what left the queue,
            // and the order of everything else is untouched.
            expect(ids(state)).toEqual(ids(before).filter((id) => !promoted.includes(id)))
            expect(promoted.every((id) => ids(before).includes(id))).toBe(true)
            if (operation.op === "queued") expect(promotion.promoted.length).toBeLessThanOrEqual(1)
            for (const item of promotion.promoted) {
              expect(item.notification.delivery).toBe(operation.op === "steers" ? "steer" : "queue")
              if (operation.lineage !== undefined) {
                expect(item.notification.targetLineageId).toBe(operation.lineage)
              }
              if (operation.op === "steers") expect(item.seq).toBeLessThanOrEqual(cutoff)
            }
          }
          expect(state.items.length).toBeLessThanOrEqual(capacity)
          expect(state.capacity).toBe(capacity)
          // Admission order is the durable journal order, so the sequences the
          // state retains are strictly increasing however it was reached.
          const seqs = state.items.map((item) => item.seq)
          expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
          expect(new Set(seqs).size).toBe(seqs.length)
        }
      }),
      params
    )
  })

  it("drops exactly the promoted ids when a durable record is replayed", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: 1, max: 8 }), operations, (capacity, script) => {
        let state = NotificationState.empty(capacity)
        let seq = 0
        for (const operation of script) {
          if (operation.op !== "admit") continue
          seq += 1
          state = NotificationState.admit(state, notification(operation, seq), seq).state
        }
        const retained = ids(state)
        const half = retained.filter((_, index) => index % 2 === 0)
        const replayed = NotificationState.applyPromoted(state, half)

        expect(ids(replayed)).toEqual(retained.filter((id) => !half.includes(id)))
        // Replaying ids nobody admitted is not an error and changes nothing.
        expect(ids(NotificationState.applyPromoted(replayed, ["never-admitted"]))).toEqual(ids(replayed))
      }),
      params
    )
  })
})
