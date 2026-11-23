import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Ownership, RunStore } from "../src/index.ts"
import * as TestRunStore from "../src/test/TestRunStore.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const owners: Record<"a" | "b", Ownership.OwnerId> = {
  a: { hostId: "host-a", pid: 1001, nonce: "nonce-a" },
  b: { hostId: "host-b", pid: 1002, nonce: "nonce-b" }
}

const sameOwner = (x: Ownership.OwnerId | null | undefined, y: Ownership.OwnerId): boolean =>
  x != null && x.hostId === y.hostId && x.pid === y.pid && x.nonce === y.nonce

describe("@smthrs/run-store SQLite lifecycle & ownership fuzz invariants", () => {
  it("create/get/claim/activate/abandonClaim/requestCancel preserve ownership fencing and monotonic cancellation over real SQLite", async () => {
    const ownerArb = Schema.Literals(["a", "b"])
    const opArb = Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("claim"), owner: ownerArb }),
      Schema.Struct({ _tag: Schema.Literal("activate"), owner: ownerArb }),
      Schema.Struct({ _tag: Schema.Literal("abandon"), owner: ownerArb }),
      Schema.Struct({ _tag: Schema.Literal("cancel") }),
      Schema.Struct({ _tag: Schema.Literal("ackCancel"), owner: ownerArb }),
      Schema.Struct({ _tag: Schema.Literal("get") })
    ])
    const arb = Arbitrary.schema(Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(14))))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const runId = "run-fuzz-1"
            yield* store.create(runId, JSON.stringify({ step: 0 }))
            const dup = yield* Effect.result(store.create(runId, JSON.stringify({ step: 1 })))
            if (Result.isSuccess(dup)) return false

            let cancelRequested = false
            let lastClaimedBy: Ownership.OwnerId | undefined
            let lastClaimedAt: number | undefined
            const nowMs = Date.now()

            for (const op of ops) {
              const current = yield* store.get(runId)
              if (cancelRequested && current.cancelRequestedAtMs === undefined) return false

              if (op._tag === "claim") {
                const claimant = owners[op.owner]
                const outcome = yield* store.claim(runId, current, claimant, nowMs)
                if (outcome._tag === "Claimed") {
                  lastClaimedBy = claimant
                  lastClaimedAt = nowMs
                }
              } else if (op._tag === "activate") {
                if (lastClaimedAt !== undefined) {
                  const claimant = owners[op.owner]
                  const outcome = yield* store.activate(runId, claimant, lastClaimedAt, current)
                  if (
                    lastClaimedBy !== undefined && !sameOwner(lastClaimedBy, claimant) && outcome._tag === "Activated"
                  ) {
                    return false
                  }
                }
              } else if (op._tag === "abandon") {
                if (lastClaimedAt !== undefined) {
                  yield* store.abandonClaim(runId, owners[op.owner], lastClaimedAt)
                }
              } else if (op._tag === "cancel") {
                yield* store.requestCancel(runId, nowMs)
                cancelRequested = true
              } else if (op._tag === "ackCancel") {
                const owner = owners[op.owner]
                const acked = yield* store.acknowledgeCancel(runId, owner, nowMs)
                if (acked && !cancelRequested) return false
                if (acked && !sameOwner(current.owner, owner)) return false
              } else {
                const row = yield* store.get(runId)
                if (row.runId !== runId) return false
              }
            }
            return true
          }).pipe(Effect.provide(TestRunStore.layer)),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
