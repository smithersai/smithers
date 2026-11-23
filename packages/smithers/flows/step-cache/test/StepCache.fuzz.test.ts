import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CacheStore } from "../src/index.ts"
import * as TestCacheStore from "../src/test/TestCacheStore.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/step-cache SQLite state-machine fuzz invariants", () => {
  it("put/get/evict/conflict/fenced-CAS and immutable provenance ledger match an exact reference model over real in-memory SQLite", async () => {
    const keyArb = Schema.Literals(["key_a", "key_b", "key_c", "key_d"])
    const opArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("put"),
        key: keyArb,
        val: Schema.Literals([1, 2, 3]),
        ts: Schema.Literals([1_700_000_000_000, 1_700_000_001_000]),
        runId: Schema.Literals(["run-1", "run-2"]),
        seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      }),
      Schema.Struct({
        _tag: Schema.Literal("get"),
        key: keyArb
      }),
      Schema.Struct({
        _tag: Schema.Literal("getRecorded"),
        key: keyArb,
        runId: Schema.Literals(["run-1", "run-2"]),
        seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      }),
      Schema.Struct({
        _tag: Schema.Literal("evict"),
        key: keyArb,
        fenced: Schema.Boolean,
        runId: Schema.Literals(["run-1", "run-2"]),
        seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      })
    ])
    const arb = Arbitrary.schema(Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(20))))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.gen(function*() {
            const store = yield* CacheStore.CacheStore
            const head = new Map<string, { val: number; runId: string; seq: number }>()
            const ledger = new Map<string, { val: number; ts: number }>()
            const ledgerKey = (key: string, runId: string, seq: number) => `${key}|${runId}|${seq}`
            for (const op of ops) {
              if (op._tag === "put") {
                const res = yield* store.put({
                  keyDigest: op.key,
                  result: { v: op.val },
                  meta: { source: "fuzz" },
                  createdAtMs: op.ts,
                  recordedRunId: op.runId,
                  recordedEventSeq: op.seq
                })
                const lk = ledgerKey(op.key, op.runId, op.seq)
                const recorded = ledger.get(lk)
                const existing = head.get(op.key)
                if (recorded !== undefined && (recorded.val !== op.val || recorded.ts !== op.ts)) {
                  if (res._tag !== "Conflict") return false
                } else {
                  if (recorded === undefined) ledger.set(lk, { val: op.val, ts: op.ts })
                  if (existing === undefined) {
                    if (res._tag !== "Inserted") return false
                    head.set(op.key, { val: op.val, runId: op.runId, seq: op.seq })
                  } else if (existing.val === op.val) {
                    if (res._tag !== "ExistingSame") return false
                  } else {
                    if (res._tag !== "Conflict") return false
                  }
                }
              } else if (op._tag === "get") {
                const got = yield* store.get(op.key)
                const exp = head.get(op.key)
                if (exp === undefined) {
                  if (Option.isSome(got)) return false
                } else {
                  if (Option.isNone(got)) return false
                  const r = got.value.result as { v?: number }
                  if (r?.v !== exp.val) return false
                }
              } else if (op._tag === "getRecorded") {
                const got = yield* store.get(op.key, { recordedBy: { runId: op.runId, eventSeq: op.seq } })
                const rec = ledger.get(ledgerKey(op.key, op.runId, op.seq))
                const expVal = rec?.val ?? head.get(op.key)?.val
                if (expVal === undefined) {
                  if (Option.isSome(got)) return false
                } else {
                  if (Option.isNone(got)) return false
                  const r = got.value.result as { v?: number }
                  if (r?.v !== expVal) return false
                }
              } else {
                const deleted = yield* store.evict(
                  op.key,
                  op.fenced ? { ifRecordedBy: { runId: op.runId, eventSeq: op.seq } } : undefined
                )
                const exp = head.get(op.key)
                const shouldDelete = exp !== undefined &&
                  (!op.fenced || (exp.runId === op.runId && exp.seq === op.seq))
                if (deleted !== shouldDelete) return false
                if (shouldDelete) head.delete(op.key)
              }
            }
            return true
          }).pipe(Effect.provide(TestCacheStore.layer)),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
