import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { forkWorkspaceName, Frame, MemoryTimeTravelStore } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/time-travel Frame, forkWorkspaceName & MemoryTimeTravelStore fuzz invariants", () => {
  it("Frame schemas round-trip cleanly and forkWorkspaceName is deterministic and path-safe", async () => {
    const idArb = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,24}$/)))
    const arb = Arbitrary.schema(
      Schema.Struct({
        lineageId: idArb,
        seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
        forkRunId: idArb
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ lineageId, seq, forkRunId }) =>
          Effect.sync(() => {
            const decoded = Schema.decodeUnknownSync(Frame.Frame)({ lineageId, seq })
            if (decoded.lineageId !== lineageId || decoded.seq !== seq) return false
            const ws1 = forkWorkspaceName(forkRunId)
            const ws2 = forkWorkspaceName(forkRunId)
            if (ws1 !== ws2 || ws1.length === 0) return false
            if (ws1.includes("..") || ws1.includes("/") || ws1.includes("\\")) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("MemoryTimeTravelStore snapshots & fork-id generation are consistent across arbitrary frame sequences", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
          val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))
        })
      ).pipe(Schema.check(Schema.isMaxLength(16)))
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (items) =>
          Effect.gen(function*() {
            const store = MemoryTimeTravelStore.make()
            const lineageId = "lin:root:run-1"
            const seenSeq = new Set<number>()
            const expectedState = new Map<number, string>()
            for (const item of items) {
              if (seenSeq.has(item.seq)) continue
              seenSeq.add(item.seq)
              const changeId = `chg-${item.val}`
              expectedState.set(item.seq, changeId)
              yield* store.recordSnapshot({
                runId: "run-1",
                frame: { lineageId, seq: item.seq },
                changeId
              })
            }
            for (const [seq, exp] of expectedState) {
              const snap = yield* store.snapshotAt("run-1", { lineageId, seq })
              if (snap === undefined || snap.changeId !== exp) return false
            }
            const f1 = yield* store.nextForkId("run-1", { lineageId, seq: 1 })
            const f2 = yield* store.nextForkId("run-1", { lineageId, seq: 1 })
            if (f1.length === 0 || f1 === f2) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
