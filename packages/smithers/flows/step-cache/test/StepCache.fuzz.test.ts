import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { CacheStore, CombinedCacheStore, Migrations, RemoteCacheStore } from "../src/index.ts"
import * as SqlCacheStore from "../src/internal/SqlCacheStore.ts"
import * as TestCacheStore from "../src/test/TestCacheStore.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/step-cache comprehensive SQLite, Combined & Remote fuzz invariants", () => {
  it("SqlCacheStore put/get/evict/importHead/sweepExpired/maxAgeMs/rebuildHeads match an exact reference model over real in-memory SQLite", async () => {
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
        runId: Schema.Literals(["remote-1", "remote-2"]),
        seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      }),
      Schema.Struct({
        _tag: Schema.Literal("get"),
        key: keyArb,
        maxAgeMs: Schema.Literals([0, 1000, -1])
      }),
      Schema.Struct({
        _tag: Schema.Literal("evict"),
        key: keyArb,
        fenced: Schema.Boolean,
        runId: Schema.Literals(["run-1", "run-2", "remote-1"]),
        seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      }),
      Schema.Struct({
        _tag: Schema.Literal("sweep"),
        reclaim: Schema.Boolean
      })
    ])

    type RefRow = {
      readonly val: number
      readonly runId: string
      readonly seq: number
      readonly imported: boolean
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(28)))),
        (ops) =>
          Effect.gen(function*() {
            const store = yield* CacheStore.CacheStore
            const head = new Map<string, RefRow>()
            const ledger = new Map<string, { readonly val: number; readonly ts: number }>()
            const candidates: Array<{ readonly keyDigest: string; readonly recordedRunId: string; readonly recordedEventSeq: number }> = []

            for (const op of ops) {
              if (op._tag === "put") {
                const entry: CacheStore.CacheEntry = {
                  keyDigest: op.key,
                  result: { val: op.val },
                  meta: { source: "put" },
                  createdAtMs: op.ts,
                  recordedRunId: op.runId,
                  recordedEventSeq: op.seq
                }
                const res = yield* store.put(entry)
                const ledgerKey = `${op.key}:${op.runId}:${op.seq}`
                const prevLedger = ledger.get(ledgerKey)
                if (prevLedger !== undefined && (prevLedger.val !== op.val || prevLedger.ts !== op.ts)) {
                  if (res._tag !== "Conflict") return false
                } else {
                  if (prevLedger === undefined) {
                    ledger.set(ledgerKey, { val: op.val, ts: op.ts })
                    candidates.push({ keyDigest: op.key, recordedRunId: op.runId, recordedEventSeq: op.seq })
                  }
                  const existing = head.get(op.key)
                  if (existing === undefined) {
                    if (res._tag !== "Inserted") return false
                    head.set(op.key, { val: op.val, runId: op.runId, seq: op.seq, imported: false })
                  } else if (existing.val === op.val) {
                    if (res._tag !== "ExistingSame") return false
                  } else {
                    if (res._tag !== "Conflict") return false
                  }
                }
              } else if (op._tag === "importHead") {
                const entry: CacheStore.CacheEntry = {
                  keyDigest: op.key,
                  result: { val: op.val },
                  meta: { source: "import" },
                  createdAtMs: op.ts,
                  recordedRunId: op.runId,
                  recordedEventSeq: op.seq
                }
                const res = yield* store.importHead!(entry)
                const existing = head.get(op.key)
                if (existing === undefined) {
                  if (res._tag !== "Inserted") return false
                  head.set(op.key, { val: op.val, runId: op.runId, seq: op.seq, imported: true })
                } else if (existing.val === op.val) {
                  if (res._tag !== "ExistingSame") return false
                } else {
                  if (res._tag !== "Conflict") return false
                }
              } else if (op._tag === "get") {
                const got = yield* store.get(
                  op.key,
                  op.maxAgeMs >= 0 ? { maxAgeMs: op.maxAgeMs } : undefined
                )
                const exp = head.get(op.key)
                if (op.maxAgeMs >= 0) {
                  // Entries from 2023 are always older than 0 or 1000ms
                  if (Option.isSome(got)) return false
                } else if (exp === undefined) {
                  if (Option.isSome(got)) return false
                } else {
                  if (Option.isNone(got)) return false
                  const r = got.value.result as { val?: number }
                  if (r?.val !== exp.val) return false
                }
              } else if (op._tag === "evict") {
                const deleted = yield* store.evict(
                  op.key,
                  op.fenced
                    ? { ifRecordedBy: { runId: op.runId, eventSeq: op.seq } }
                    : undefined
                )
                const exp = head.get(op.key)
                const shouldDelete = exp !== undefined &&
                  (!op.fenced || (exp.runId === op.runId && exp.seq === op.seq))
                if (deleted !== shouldDelete) return false
                if (shouldDelete) head.delete(op.key)
              } else {
                const swept = yield* store.sweepExpired(
                  1,
                  op.reclaim
                    ? { canReclaimRecorded: () => Effect.succeed(true) }
                    : { canReclaimRecorded: () => Effect.succeed(false) }
                )
                if (swept !== head.size) return false
                head.clear()
                if (op.reclaim) ledger.clear()
              }
            }

            // Exercise rebuildHeads on deduplicated recorded candidates (and duplicate rejection)
            const dedup = new Map<string, { readonly keyDigest: string; readonly recordedRunId: string; readonly recordedEventSeq: number }>()
            for (const c of candidates) dedup.set(c.keyDigest, c)
            const rebuilt = yield* SqlCacheStore.rebuildHeads(dedup.values())
            if (rebuilt < 0) return false
            const hasConflict = candidates.some((c) => {
              const first = dedup.get(c.keyDigest)!
              return first.recordedRunId !== c.recordedRunId || first.recordedEventSeq !== c.recordedEventSeq
            })
            if (hasConflict) {
              const dupRes = yield* Effect.result(SqlCacheStore.rebuildHeads(candidates))
              if (Result.isSuccess(dupRes)) return false
            }

            // Invalid inputs must fail cleanly with CacheStoreError
            const badKey = yield* Effect.result(store.get(""))
            if (Result.isSuccess(badKey)) return false
            const badAge = yield* Effect.result(store.get("key_a", { maxAgeMs: -5 }))
            if (Result.isSuccess(badAge)) return false
            const badSweep = yield* Effect.result(store.sweepExpired(-1))
            if (Result.isSuccess(badSweep)) return false
            return true
          }).pipe(Effect.provide(Layer.mergeAll(CacheStore.layer.pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))), Logger.layer([])))),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("CombinedCacheStore, RemoteCacheStore & CacheStore.layerNoop maintain coherence & degrade safely under HTTP faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        publication: Schema.Literals(["inline", "deferred"]),
        key: Schema.Literals(["k1", "k2", "k3"]),
        val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
        evictLocalBeforeRead: Schema.Boolean,
        remoteFault: Schema.Literals(["none", "status_500", "status_401", "status_409", "corrupt_json", "wrong_key"]),
        withMaxAge: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ publication, key, val, evictLocalBeforeRead, remoteFault, withMaxAge }) =>
          Effect.gen(function*() {
            const remoteMap = new Map<string, string>()
            const fakeHttp = HttpClient.make((req) => {
              const k = new URL(req.url).pathname.split("/").at(-1)!
              if (remoteFault === "status_500") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("boom", { status: 500 })))
              }
              if (remoteFault === "status_401") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("denied", { status: 401 })))
              }
              if (req.method === "GET") {
                if (remoteFault === "corrupt_json") {
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{bad", { status: 200 })))
                }
                if (remoteFault === "wrong_key") {
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      req,
                      new Response(
                        JSON.stringify({
                          keyDigest: "other_key",
                          result: { val },
                          meta: {},
                          createdAtMs: Date.now(),
                          recordedRunId: "r",
                          recordedEventSeq: 1
                        }),
                        { status: 200, headers: { "content-type": "application/json" } }
                      )
                    )
                  )
                }
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
                if (remoteFault === "status_409") {
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 409 })))
                }
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
            const remoteLayer = RemoteCacheStore.layer({ endpoint: "https://cache.internal" }).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp))
            )
            const combinedLayer = CombinedCacheStore.layer({
              local: Effect.succeed(local),
              remote: Effect.provide(CacheStore.CacheStore, remoteLayer),
              publication
            })
            const combined = yield* Effect.provide(CacheStore.CacheStore, combinedLayer)
            const remote = yield* Effect.provide(CacheStore.CacheStore, remoteLayer)

            const entry: CacheStore.CacheEntry = {
              keyDigest: key,
              result: { val },
              meta: {},
              createdAtMs: withMaxAge ? 1_700_000_000_000 : Date.now(),
              recordedRunId: "run-1",
              recordedEventSeq: 1
            }

            // Local put succeeds even when remote fails!
            const putRes = yield* combined.put(entry)
            if (putRes._tag !== "Inserted") return false

            // Conflicting local put returns Conflict and does not overwrite
            const conflictRes = yield* combined.put({ ...entry, result: { val: val + 1 } })
            if (conflictRes._tag !== "Conflict") return false

            if (evictLocalBeforeRead) {
              const evicted = yield* combined.evict(key)
              if (!evicted) return false
            }

            const got = yield* combined.get(key, withMaxAge ? { maxAgeMs: 1000 } : undefined)
            if (withMaxAge) {
              if (Option.isSome(got)) return false
            } else if (!evictLocalBeforeRead) {
              if (Option.isNone(got)) return false
              const r = got.value.result as { val?: number }
              if (r?.val !== val) return false
            } else if (remoteFault === "none" && publication === "inline") {
              if (Option.isNone(got)) return false
              const r = got.value.result as { val?: number }
              if (r?.val !== val) return false
            } else {
              // Deferred or remote faulted: degrades gracefully to None without throwing!
              if (Option.isSome(got)) return false
            }

            // Exercise combined.sweepExpired & remote.evict / sweepExpired / importHead
            const swept = yield* combined.sweepExpired(10_000_000_000)
            if (swept < 0) return false
            yield* Effect.result(remote.evict(key))
            yield* Effect.result(remote.sweepExpired(1))
            if (remote.importHead) yield* Effect.result(remote.importHead(entry))

            // Exercise CacheStore.layerNoop (every unoverridden op fails with unavailable)
            const noop = yield* Effect.provide(CacheStore.CacheStore, CacheStore.layerNoop())
            if (Result.isSuccess(yield* Effect.result(noop.get(key)))) return false
            if (Result.isSuccess(yield* Effect.result(noop.put(entry)))) return false
            if (noop.importHead && Result.isSuccess(yield* Effect.result(noop.importHead(entry)))) return false
            if (Result.isSuccess(yield* Effect.result(noop.evict(key)))) return false
            if (Result.isSuccess(yield* Effect.result(noop.sweepExpired(1)))) return false
            return true
          }).pipe(Effect.provide(Layer.mergeAll(TestCacheStore.layer, Logger.layer([])))),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
