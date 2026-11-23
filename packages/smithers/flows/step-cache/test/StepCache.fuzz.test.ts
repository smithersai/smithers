import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import { CacheStore, CombinedCacheStore, RemoteCacheStore } from "../src/index.ts"
import * as TestCacheStore from "../src/test/TestCacheStore.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/step-cache comprehensive SQLite, Combined & Remote fuzz invariants", () => {
  it("SqlCacheStore put/get/evict/importHead/sweepExpired/maxAgeMs match an exact reference model over real in-memory SQLite", async () => {
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
        _tag: Schema.Literal("importHead"),
        key: keyArb,
        val: Schema.Literals([1, 2, 3]),
        ts: Schema.Literals([1_700_000_000_000, 1_700_000_001_000]),
        runId: Schema.Literals(["remote-run"]),
        seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))
      }),
      Schema.Struct({ _tag: Schema.Literal("get"), key: keyArb }),
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
      }),
      Schema.Struct({ _tag: Schema.Literal("sweep") })
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
              } else if (op._tag === "importHead") {
                if (store.importHead === undefined) return false
                const res = yield* store.importHead({
                  keyDigest: op.key,
                  result: { v: op.val },
                  meta: { source: "remote" },
                  createdAtMs: op.ts,
                  recordedRunId: op.runId,
                  recordedEventSeq: op.seq
                })
                const existing = head.get(op.key)
                if (existing === undefined) {
                  if (res._tag !== "Inserted") return false
                  head.set(op.key, { val: op.val, runId: op.runId, seq: op.seq })
                } else if (existing.val === op.val) {
                  if (res._tag !== "ExistingSame") return false
                } else {
                  if (res._tag !== "Conflict") return false
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
              } else if (op._tag === "evict") {
                const deleted = yield* store.evict(
                  op.key,
                  op.fenced ? { ifRecordedBy: { runId: op.runId, eventSeq: op.seq } } : undefined
                )
                const exp = head.get(op.key)
                const shouldDelete = exp !== undefined &&
                  (!op.fenced || (exp.runId === op.runId && exp.seq === op.seq))
                if (deleted !== shouldDelete) return false
                if (shouldDelete) head.delete(op.key)
              } else {
                // Sweep entries older than 1ms (all entries from 2023 are expired relative to Date.now())
                const swept = yield* store.sweepExpired(1)
                if (swept !== head.size) return false
                head.clear()
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

  it("CombinedCacheStore & RemoteCacheStore maintain L1/L2 read-through & write-through coherence over HTTP", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        publication: Schema.Literals(["inline", "deferred"]),
        key: Schema.Literals(["k1", "k2", "k3"]),
        val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
        evictLocalBeforeRead: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ publication, key, val, evictLocalBeforeRead }) =>
          Effect.gen(function*() {
            const remoteMap = new Map<string, string>()
            const fakeHttp = HttpClient.make((req) => {
              const k = new URL(req.url).pathname.split("/").at(-1)!
              if (req.method === "GET") {
                const raw = remoteMap.get(k)
                if (raw === undefined) {
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 404 })))
                }
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    req,
                    new Response(raw, { status: 200, headers: { "content-type": "application/json" } })
                  )
                )
              }
              if (req.method === "PUT") {
                const bodyText = req.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(req.body.body)
                  : req.body._tag === "Raw"
                  ? String(req.body.body)
                  : ""
                const existing = remoteMap.get(k)
                if (existing === undefined) {
                  remoteMap.set(k, bodyText)
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 201 })))
                }
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, new Response(null, { status: existing === bodyText ? 200 : 409 }))
                )
              }
              if (req.method === "DELETE") {
                const had = remoteMap.delete(k)
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: had ? 204 : 404 })))
              }
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 405 })))
            })

            const local = yield* CacheStore.CacheStore
            const remote = yield* RemoteCacheStore.make({ endpoint: "https://cache.internal" }).pipe(
              Effect.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp))
            )
            const combined = CombinedCacheStore.make({ local, remote, publication })
            const entry: CacheStore.CacheEntry = {
              keyDigest: key,
              result: { val },
              meta: {},
              createdAtMs: Date.now(),
              recordedRunId: "run-1",
              recordedEventSeq: 1
            }
            const putRes = yield* combined.put(entry)
            if (putRes._tag !== "Inserted") return false
            if (publication === "inline" && !remoteMap.has(key)) return false
            if (publication === "deferred" && remoteMap.has(key)) return false

            if (evictLocalBeforeRead) {
              yield* local.evict(key)
            }
            const got = yield* combined.get(key)
            if (evictLocalBeforeRead && publication === "deferred") {
              return Option.isNone(got)
            }
            if (Option.isNone(got)) return false
            const r = got.value.result as { val?: number }
            return r?.val === val
          }).pipe(Effect.provide(TestCacheStore.layer)),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
