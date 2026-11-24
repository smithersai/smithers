import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { describe, expect, it } from "vitest"
import { CacheStore, Migrations, RemoteCacheStore } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const makeStubClient = (
  handler: (req: Parameters<HttpClient.HttpClient["execute"]>[0]) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >
): Layer.Layer<HttpClient.HttpClient> => Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler))

const webRes = (
  req: Parameters<HttpClient.HttpClient["execute"]>[0],
  body: BodyInit | null,
  init: ResponseInit
): HttpClientResponse.HttpClientResponse => HttpClientResponse.fromWeb(req, new Response(body, init))

describe("@smthrs/step-cache Wave 10 deep fuzz", () => {
  it(
    "RemoteCacheStore.make rejects every invalid options/endpoint/headers/timeout/maxResponseBytes variant",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          variant: Schema.Literals([
            "nullOptions",
            "unknownKey",
            "symbolKey",
            "getterOption",
            "nonEnumOption",
            "nonStringEndpoint",
            "paddedEndpoint",
            "controlEndpoint",
            "surrogateEndpoint",
            "malformedUrl",
            "plainHttpRemote",
            "urlWithUser",
            "urlWithSearch",
            "urlWithHash",
            "headersNull",
            "headersMap",
            "headersSymbol",
            "headersBadName",
            "headersGetter",
            "headersControlVal",
            "headersSurrogateVal",
            "headersTooLongVal",
            "zeroTimeout",
            "negTimeout",
            "infTimeout",
            "zeroMaxBytes",
            "floatMaxBytes",
            "hugeMaxBytes"
          ]),
          salt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 }))
        })
      )
      const noopClient = makeStubClient((req) => Effect.succeed(webRes(req, null, { status: 404 })))
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ variant, salt }) =>
            Effect.gen(function*() {
              let opts: unknown
              switch (variant) {
                case "nullOptions":
                  opts = null
                  break
                case "unknownKey":
                  opts = { endpoint: "https://cache.example.com", extra: salt }
                  break
                case "symbolKey":
                  opts = { endpoint: "https://cache.example.com", [Symbol("k")]: 1 }
                  break
                case "getterOption":
                  opts = {
                    get endpoint() {
                      return "https://cache.example.com"
                    }
                  }
                  break
                case "nonEnumOption": {
                  const o: Record<string, unknown> = {}
                  Object.defineProperty(o, "endpoint", { value: "https://cache.example.com", enumerable: false })
                  opts = o
                  break
                }
                case "nonStringEndpoint":
                  opts = { endpoint: salt }
                  break
                case "paddedEndpoint":
                  opts = { endpoint: " https://cache.example.com " }
                  break
                case "controlEndpoint":
                  opts = { endpoint: "https://cache.example.com/\x01" }
                  break
                case "surrogateEndpoint":
                  opts = { endpoint: `https://cache.example.com/\uD800${salt}` }
                  break
                case "malformedUrl":
                  opts = { endpoint: "not-a-url" }
                  break
                case "plainHttpRemote":
                  opts = { endpoint: "http://cache.example.com" }
                  break
                case "urlWithUser":
                  opts = { endpoint: "https://user:pass@cache.example.com" }
                  break
                case "urlWithSearch":
                  opts = { endpoint: "https://cache.example.com?x=1" }
                  break
                case "urlWithHash":
                  opts = { endpoint: "https://cache.example.com#frag" }
                  break
                case "headersNull":
                  opts = { endpoint: "https://cache.example.com", headers: null }
                  break
                case "headersMap":
                  opts = { endpoint: "https://cache.example.com", headers: new Map([["x-a", "1"]]) }
                  break
                case "headersSymbol":
                  opts = { endpoint: "https://cache.example.com", headers: { [Symbol("h")]: "1" } }
                  break
                case "headersBadName":
                  opts = { endpoint: "https://cache.example.com", headers: { "bad header": "1" } }
                  break
                case "headersGetter":
                  opts = {
                    endpoint: "https://cache.example.com",
                    headers: {
                      get "x-a"() {
                        return "1"
                      }
                    }
                  }
                  break
                case "headersControlVal":
                  opts = { endpoint: "https://cache.example.com", headers: { "x-a": "v\r\n" } }
                  break
                case "headersSurrogateVal":
                  opts = { endpoint: "https://cache.example.com", headers: { "x-a": "\uDC00" } }
                  break
                case "headersTooLongVal":
                  opts = { endpoint: "https://cache.example.com", headers: { "x-a": "a".repeat(16 * 1024 + 1) } }
                  break
                case "zeroTimeout":
                  opts = { endpoint: "https://cache.example.com", requestTimeout: 0 }
                  break
                case "negTimeout":
                  opts = { endpoint: "https://cache.example.com", requestTimeout: -5 }
                  break
                case "infTimeout":
                  opts = { endpoint: "https://cache.example.com", requestTimeout: Number.POSITIVE_INFINITY }
                  break
                case "zeroMaxBytes":
                  opts = { endpoint: "https://cache.example.com", maxResponseBytes: 0 }
                  break
                case "floatMaxBytes":
                  opts = { endpoint: "https://cache.example.com", maxResponseBytes: 12.5 }
                  break
                case "hugeMaxBytes":
                  opts = {
                    endpoint: "https://cache.example.com",
                    maxResponseBytes: RemoteCacheStore.maximumEntryBytes + 1
                  }
                  break
              }
              const res = yield* Effect.result(RemoteCacheStore.make(opts as RemoteCacheStore.Options))
              return Result.isFailure(res) && res.failure.code === "invalid_cache"
            }).pipe(Effect.provide(noopClient)),
          { seed, executions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
    },
    60_000
  )

  it(
    "RemoteCacheStore handles bounded streams, content-length violations, timeouts, transport error codes, decode failures, and all CRUD statuses",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "getHit",
            "getHitFenced",
            "getStale",
            "get404",
            "get500",
            "getBadContentLength",
            "getTooLargeDeclared",
            "getTooLargeStreamed",
            "getStreamError",
            "getInvalidJson",
            "getInvalidSchema",
            "getWrongKey",
            "getTimeout",
            "getTransportOsCode",
            "getTransportNoCode",
            "put201",
            "put200",
            "put409",
            "put500",
            "evict200Fenced",
            "evict404",
            "evict500",
            "sweepOk",
            "sweepBad"
          ]),
          seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, seq }) =>
            Effect.gen(function*() {
              const key = `k_${seq}_abc`
              const now = Date.now()
              const validEntry: CacheStore.CacheEntry = {
                keyDigest: key,
                result: { seq, emoji: "😀é€" },
                meta: { tag: "w10" },
                createdAtMs: mode === "getStale" ? 1 : now,
                recordedRunId: `run-😀-${seq}`,
                recordedEventSeq: seq
              }

              const clientLayer = makeStubClient((req) => {
                switch (mode) {
                  case "getHit":
                  case "getHitFenced":
                  case "getStale":
                    return Effect.succeed(
                      webRes(req, JSON.stringify(validEntry), {
                        status: 200,
                        headers: { "content-type": "application/json" }
                      })
                    )
                  case "get404":
                  case "evict404":
                    return Effect.succeed(webRes(req, null, { status: 404 }))
                  case "get500":
                  case "put500":
                  case "evict500":
                    return Effect.succeed(webRes(req, "boom", { status: 500 }))
                  case "getBadContentLength":
                    return Effect.succeed(
                      webRes(req, "{}", { status: 200, headers: { "content-length": "not-a-number" } })
                    )
                  case "getTooLargeDeclared":
                    return Effect.succeed(
                      webRes(req, "{}", { status: 200, headers: { "content-length": "99999" } })
                    )
                  case "getTooLargeStreamed": {
                    const stream = new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(new Uint8Array(600))
                        controller.enqueue(new Uint8Array(600))
                        controller.close()
                      }
                    })
                    return Effect.succeed(webRes(req, stream, { status: 200 }))
                  }
                  case "getStreamError": {
                    const stream = new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.error(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
                      }
                    })
                    return Effect.succeed(webRes(req, stream, { status: 200 }))
                  }
                  case "getInvalidJson":
                    return Effect.succeed(webRes(req, "{not-json", { status: 200 }))
                  case "getInvalidSchema":
                    return Effect.succeed(
                      webRes(req, JSON.stringify({ keyDigest: key, createdAtMs: -1 }), { status: 200 })
                    )
                  case "getWrongKey":
                    return Effect.succeed(
                      webRes(req, JSON.stringify({ ...validEntry, keyDigest: "other_key_999" }), { status: 200 })
                    )
                  case "getTimeout":
                    return Effect.sleep("200 millis").pipe(Effect.as(webRes(req, null, { status: 404 })))
                  case "getTransportOsCode": {
                    const inner = Object.assign(new Error("refused"), { code: "ECONNREFUSED" })
                    const outer = new Error("wrapped", { cause: inner })
                    return Effect.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({ request: req, cause: outer })
                      })
                    )
                  }
                  case "getTransportNoCode":
                    return Effect.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.InvalidUrlError({ request: req, cause: "bad" })
                      })
                    )
                  case "put201":
                    return Effect.succeed(webRes(req, null, { status: 201 }))
                  case "put200":
                  case "evict200Fenced":
                    return Effect.succeed(webRes(req, null, { status: 200 }))
                  case "put409":
                    return Effect.succeed(webRes(req, null, { status: 409 }))
                  case "sweepOk":
                  case "sweepBad":
                    return Effect.succeed(webRes(req, null, { status: 200 }))
                }
              })

              const store = yield* RemoteCacheStore.make({
                endpoint: "http://127.0.0.1:8787/cache/",
                headers: { "x-api-key": "secret-token", "x-client": "wave10" },
                requestTimeout: mode === "getTimeout" ? "25 millis" : "2 seconds",
                maxResponseBytes: 1024
              }).pipe(Effect.provide(clientLayer))

              switch (mode) {
                case "getHit": {
                  const got = yield* store.get(key)
                  return Option.isSome(got) && got.value.keyDigest === key
                }
                case "getHitFenced": {
                  const got = yield* store.get(key, {
                    recordedBy: { runId: validEntry.recordedRunId, eventSeq: seq }
                  })
                  return Option.isSome(got)
                }
                case "getStale": {
                  const got = yield* store.get(key, { maxAgeMs: 1000 })
                  return Option.isNone(got)
                }
                case "get404": {
                  const got = yield* store.get(key)
                  return Option.isNone(got)
                }
                case "get500":
                case "getBadContentLength":
                case "getTooLargeDeclared":
                case "getTooLargeStreamed":
                case "getStreamError":
                case "getInvalidJson":
                case "getTimeout":
                case "getTransportOsCode":
                case "getTransportNoCode": {
                  const r = yield* Effect.result(store.get(key))
                  return Result.isFailure(r) && r.failure.code === "persistence_failed"
                }
                case "getInvalidSchema":
                case "getWrongKey": {
                  const r = yield* Effect.result(store.get(key))
                  return Result.isFailure(r) && r.failure.code === "decode_failed"
                }
                case "put201": {
                  const out = yield* store.put(validEntry)
                  return out._tag === "Inserted"
                }
                case "put200": {
                  const out = yield* store.put(validEntry)
                  return out._tag === "ExistingSame"
                }
                case "put409": {
                  const out = yield* store.put(validEntry)
                  return out._tag === "Conflict"
                }
                case "put500": {
                  const r = yield* Effect.result(store.put(validEntry))
                  return Result.isFailure(r) && r.failure.code === "persistence_failed"
                }
                case "evict200Fenced":
                  return (yield* store.evict(key, {
                    ifRecordedBy: { runId: validEntry.recordedRunId, eventSeq: seq }
                  })) === true
                case "evict404":
                  return (yield* store.evict(key)) === false
                case "evict500": {
                  const r = yield* Effect.result(store.evict(key))
                  return Result.isFailure(r) && r.failure.code === "persistence_failed"
                }
                case "sweepOk":
                  return (yield* store.sweepExpired(seq)) === 0
                case "sweepBad": {
                  const r = yield* Effect.result(store.sweepExpired(-1))
                  return Result.isFailure(r) && r.failure.code === "invalid_cache"
                }
              }
            }),
          { seed: seed + 1, executions: Math.min(executions, 120) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
    },
    60_000
  )

  it(
    "SqlCacheStore & CacheAdmission handle UTF-8 boundaries, corrupt SQL rows, surrogate validation, and injected persistence errors",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          caseKind: Schema.Literals([
            "utf8MultiByte",
            "corruptJsonRow",
            "invalidSchemaRow",
            "oversizedRow",
            "badSurrogateRunId",
            "badLowSurrogateRunId",
            "badHighPairRunId",
            "badNulRunId",
            "badSnapshotNull",
            "badSnapshotGetter",
            "badSnapshotUndefinedVal",
            "badRecordedBy",
            "faultDbConstraint",
            "faultDbUnavailable",
            "faultSqlConstraint",
            "faultSqlUnique",
            "faultSqlGeneric",
            "faultCacheStorePassthrough"
          ]),
          idx: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ caseKind, idx }) =>
            Effect.gen(function*() {
              const key = `sqlk_${idx}`
              if (caseKind.startsWith("fault")) {
                const makeFault = () => {
                  switch (caseKind) {
                    case "faultDbConstraint":
                      return new DatabaseError({ code: "constraint" })
                    case "faultDbUnavailable":
                      return new DatabaseError({ code: "busy" })
                    case "faultSqlConstraint":
                      return new SqlError.SqlError({ reason: new SqlError.ConstraintError({ cause: new Error("c") }) })
                    case "faultSqlUnique":
                      return new SqlError.SqlError({
                        reason: new SqlError.UniqueViolation({ cause: new Error("u"), constraint: "cache" })
                      })
                    case "faultSqlGeneric":
                      return new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: new Error("x") }) })
                    default:
                      return new CacheStore.CacheStoreError({ code: "decode_failed", message: "pass" })
                  }
                }
                const faultyWriter = Layer.succeed(DurableWriter, {
                  write: () => Effect.fail(makeFault() as never)
                })
                const dbLayer = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
                const storeLayer = CacheStore.layer.pipe(
                  Layer.provide(Layer.mergeAll(dbLayer, faultyWriter))
                )
                const r = yield* Effect.gen(function*() {
                  const store = yield* CacheStore.CacheStore
                  return yield* Effect.result(store.evict(key))
                }).pipe(Effect.provide(storeLayer))
                if (!Result.isFailure(r)) return false
                if (
                  caseKind === "faultDbConstraint" || caseKind === "faultSqlConstraint" || caseKind === "faultSqlUnique"
                ) {
                  return r.failure.code === "constraint"
                }
                if (caseKind === "faultCacheStorePassthrough") {
                  return r.failure.code === "decode_failed"
                }
                return r.failure.code === "persistence_failed"
              }

              const dbLayer = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
              const fullLayer = Layer.provideMerge(CacheStore.layer, dbLayer)

              return yield* Effect.gen(function*() {
                const store = yield* CacheStore.CacheStore
                const sql = yield* SqlClient.SqlClient
                switch (caseKind) {
                  case "utf8MultiByte": {
                    const entry: CacheStore.CacheEntry = {
                      keyDigest: key,
                      result: { two: "éàü", three: "€中", four: "😀🚀" },
                      meta: { note: "ü€😀" },
                      createdAtMs: 1000 + idx,
                      recordedRunId: `run-😀-${idx}`,
                      recordedEventSeq: idx
                    }
                    const putOut = yield* store.put(entry)
                    const got = yield* store.get(key)
                    return putOut._tag === "Inserted" && Option.isSome(got)
                  }
                  case "corruptJsonRow": {
                    yield* sql`PRAGMA ignore_check_constraints = ON`
                    yield* sql`INSERT INTO flows_step_cache (key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq) VALUES (${key}, ${"{bad"}, ${"{}"}, ${1000}, ${"r1"}, ${1})`
                    const r = yield* Effect.result(store.get(key))
                    return Result.isFailure(r) && r.failure.code === "decode_failed"
                  }
                  case "invalidSchemaRow": {
                    yield* sql`PRAGMA ignore_check_constraints = ON`
                    yield* sql`INSERT INTO flows_step_cache (key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq) VALUES (${key}, ${"{}"}, ${"{}"}, ${-5}, ${""}, ${1})`
                    const r = yield* Effect.result(store.get(key))
                    return Result.isFailure(r) && r.failure.code === "decode_failed"
                  }
                  case "oversizedRow": {
                    // Exceeds 4MiB via 3-byte UTF-8 chars (1.5M chars * 3 bytes = 4.5MiB, length < 4MiB so triggers loop check!)
                    const big = `"${"€".repeat(1_500_000)}"`
                    yield* sql`INSERT INTO flows_step_cache (key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq) VALUES (${key}, ${big}, ${"{}"}, ${1000}, ${"r1"}, ${1})`
                    const r = yield* Effect.result(store.get(key))
                    return Result.isFailure(r) && r.failure.code === "decode_failed"
                  }
                  case "badSurrogateRunId":
                  case "badLowSurrogateRunId":
                  case "badHighPairRunId":
                  case "badNulRunId": {
                    const runId = caseKind === "badSurrogateRunId"
                      ? "run-\uD800"
                      : caseKind === "badLowSurrogateRunId"
                      ? "run-\uDC00"
                      : caseKind === "badHighPairRunId"
                      ? "run-\uD800a"
                      : "run-\0x"
                    const r = yield* Effect.result(
                      store.put({
                        keyDigest: key,
                        result: 1,
                        meta: null,
                        createdAtMs: 1000,
                        recordedRunId: runId,
                        recordedEventSeq: 1
                      })
                    )
                    return Result.isFailure(r) && r.failure.code === "invalid_cache"
                  }
                  case "badSnapshotNull": {
                    const r = yield* Effect.result(store.put(null as unknown as CacheStore.CacheEntry))
                    return Result.isFailure(r) && r.failure.code === "invalid_cache"
                  }
                  case "badSnapshotGetter": {
                    const getterEntry = {
                      get keyDigest() {
                        return key
                      },
                      result: 1,
                      meta: null,
                      createdAtMs: 1000,
                      recordedRunId: "r1",
                      recordedEventSeq: 1
                    }
                    const r = yield* Effect.result(store.put(getterEntry as unknown as CacheStore.CacheEntry))
                    return Result.isFailure(r) && r.failure.code === "invalid_cache"
                  }
                  case "badSnapshotUndefinedVal": {
                    const r = yield* Effect.result(
                      store.put({
                        keyDigest: key,
                        result: { bad: undefined },
                        meta: null,
                        createdAtMs: 1000,
                        recordedRunId: "r1",
                        recordedEventSeq: 1
                      })
                    )
                    return Result.isFailure(r) && r.failure.code === "invalid_cache"
                  }
                  case "badRecordedBy": {
                    const r = yield* Effect.result(store.get(key, { recordedBy: { runId: "", eventSeq: -1 } }))
                    return Result.isFailure(r) && r.failure.code === "invalid_cache"
                  }
                  default:
                    return false
                }
              }).pipe(Effect.provide(fullLayer))
            }).pipe(Effect.provide(Logger.layer([]))),
          { seed: seed + 2, executions: Math.min(executions, 45) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    120_000
  )
})
