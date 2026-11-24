import { FetchError } from "@electric-sql/client"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { Fuzz } from "@smthrs/fuzz"
import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import {
  Arbitrary,
  ConfigProvider,
  Duration,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  PubSub,
  Redacted,
  Schedule,
  Schema,
  Stream
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ElectricCollection, ShapeProxy, ShapeSource, SyncPolicy } from "../src/index.ts"
import { rowsIn } from "../src/internal/Batch.ts"
import { fenced, type SyncControls } from "../src/internal/fence.ts"
import { eventually, storedRows } from "./fixtures.ts"
import { sqlite } from "./sqlite.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "800" : "200"))
const fastExecutions = Math.min(executions, 30)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

const NoteSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  n: Schema.Number
})
type Note = Schema.Schema.Type<typeof NoteSchema>

const electricHeaders = (
  handle: string,
  offset: string,
  live: boolean,
  extra: Record<string, string> = {}
): Record<string, string> => ({
  "content-type": "application/json",
  "electric-handle": handle,
  "electric-offset": offset,
  ...(live
    ? { "electric-cursor": "1" }
    : { "electric-schema": JSON.stringify({ id: { type: "text" }, text: { type: "text" }, n: { type: "int4" } }) }),
  ...extra
})

describe("@smthrs/effect-electric comprehensive fuzz security & sync invariants", () => {
  it("ShapeProxy pins table/where/params, enforces GET-only/no-store/SSE refusal, maps upstream 401/403/302/503/errors to 502/503, and parses config", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["GET", "POST", "PUT", "DELETE"]),
        attackerTable: Schema.Literals(["users", "secrets"]),
        subsetKey: Schema.Literals(["subset__where", "subset__limit", "offset", "cursor"]),
        secretAs: Schema.Literals(["parameter", "bearer"]),
        cache: Schema.Literals(["no-store", "public"]),
        liveSse: Schema.Boolean,
        shouldRefuse: Schema.Boolean,
        refuseStatus: Schema.Literals([401, 403, 503]),
        upstreamStatus: Schema.Literals([200, 302, 304, 401, 403, 503, -1])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, attackerTable, subsetKey, secretAs, cache, liveSse, shouldRefuse, refuseStatus, upstreamStatus }) =>
          Effect.gen(function*() {
            let upstreamCalled = false
            let seenUrl: URL | undefined
            let seenAuth: string | undefined
            const fakeClient = HttpClient.make((req) => {
              upstreamCalled = true
              const full = new URL(req.url)
              for (const [k, v] of req.urlParams) {
                const raw = Redacted.isRedacted(v) ? String(Redacted.value(v)) : String(v)
                full.searchParams.append(k, raw)
              }
              seenUrl = full
              seenAuth = req.headers["authorization"]
              if (upstreamStatus === -1) return Effect.fail(new Error("network down") as never)
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(upstreamStatus === 304 || upstreamStatus === 503 ? null : "[]", {
                    status: upstreamStatus,
                    headers: {
                      "content-type": "application/json",
                      "cache-control": "public, max-age=3600",
                      etag: "\"upstream-etag\""
                    }
                  })
                )
              )
            })

            const qs = new URLSearchParams({
              table: attackerTable,
              where: "1=1",
              [subsetKey]: "-1",
              secret: "attacker-secret",
              source_id: "attacker-source"
            })
            if (liveSse) qs.set("live_sse", "true")
            const serverReq = HttpServerRequest.fromWeb(
              new Request(`https://app.example/api/shape?${qs.toString()}`, { method })
            )

            const shapeEffect: Effect.Effect<ShapeProxy.Shape, ShapeProxy.Refused> = shouldRefuse
              ? Effect.fail(new ShapeProxy.Refused({ status: refuseStatus, retryAfter: 7 }))
              : Effect.succeed({
                table: "public.pinned_items",
                where: "tenant_id = $1",
                params: { "1": "tenant-pinned" },
                columns: ["id", "title"]
              })

            const response = yield* ShapeProxy.make({
              url: "https://electric.internal",
              secret: Redacted.make("server-only-secret"),
              secretAs,
              sourceId: "server-source",
              cache,
              shape: shapeEffect
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpServerRequest.HttpServerRequest, serverReq),
                  Layer.succeed(HttpClient.HttpClient, fakeClient),
                  silentLogger
                )
              )
            )
            if (response.body._tag === "Stream") {
              yield* Stream.runDrain(response.body.stream).pipe(Effect.ignore)
            }

            if (method !== "GET") return !upstreamCalled && response.status === 405
            if (shouldRefuse) return !upstreamCalled && response.status === refuseStatus
            if (cache === "no-store" && liveSse) return !upstreamCalled && response.status === 400
            if (!upstreamCalled || seenUrl === undefined) return false

            if (seenUrl.searchParams.get("table") !== "public.pinned_items") return false
            if (seenUrl.searchParams.get("where") !== "tenant_id = $1") return false
            for (const key of seenUrl.searchParams.keys()) {
              if (key.startsWith("subset__")) return false
            }
            if (secretAs === "parameter" && seenUrl.searchParams.get("secret") !== "server-only-secret") return false
            if (
              secretAs === "bearer" && (seenUrl.searchParams.has("secret") || seenAuth !== "Bearer server-only-secret")
            ) {
              return false
            }

            if (upstreamStatus === -1) return response.status === 502
            if (upstreamStatus === 401 || upstreamStatus === 403 || upstreamStatus === 302) {
              return response.status === 503
            }
            if (cache === "no-store") {
              if (!(response.headers["cache-control"] ?? "").includes("no-store")) return false
              if (response.headers["etag"] !== undefined) return false
            }
            return response.status === upstreamStatus
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("rowAccess filters unauthorized rows, strips non-key fields on delete, handles control/corrupt/defect/missing-key cases", async () => {
    const rowArb = Schema.Struct({
      id: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
      allowed: Schema.Boolean,
      retry: Schema.Boolean,
      op: Schema.Literals(["insert", "update", "delete"]),
      secretField: Schema.String.pipe(Schema.check(Schema.isMaxLength(16)))
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        rows: Schema.Array(rowArb).pipe(Schema.check(Schema.isMaxLength(8))),
        validateMode: Schema.Literals(["ok", "denied", "defect"]),
        liveSse: Schema.Boolean,
        bodyMode: Schema.Literals(["normal", "malformed", "missingKey", "withControl", "nullEntry"]),
        emptyKeys: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rows, validateMode, liveSse, bodyMode, emptyKeys }) =>
          Effect.gen(function*() {
            const payload: Array<unknown> = rows.map((r) => ({
              headers: { operation: r.op },
              value: bodyMode === "missingKey"
                ? { allowed: r.allowed, retry: r.retry }
                : { id: String(r.id), allowed: r.allowed, retry: r.retry, secretField: r.secretField }
            }))
            if (bodyMode === "withControl") {
              payload.push({ headers: { control: "up-to-date" } })
            } else if (bodyMode === "nullEntry") {
              payload.push(null)
            }
            const fakeClient = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(bodyMode === "malformed" ? "not-json" : JSON.stringify(payload), {
                    status: 200,
                    headers: { "content-type": "application/json" }
                  })
                )
              )
            )
            const url = liveSse
              ? "https://app.example/api/shape?offset=-1&live_sse=true"
              : "https://app.example/api/shape?offset=-1"
            const serverReq = HttpServerRequest.fromWeb(new Request(url))
            const validate = validateMode === "defect"
              ? Effect.die(new Error("validate boom"))
              : Effect.succeed(validateMode === "ok")
            const response = yield* ShapeProxy.make({
              url: "https://electric.internal",
              shape: { table: "public.items" },
              rowAccess: {
                keyColumns: emptyKeys ? [] : ["id"],
                allows: (v) => v["allowed"] === true,
                retryIfDenied: (v) => v["retry"] === true,
                validate
              }
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpServerRequest.HttpServerRequest, serverReq),
                  Layer.succeed(HttpClient.HttpClient, fakeClient),
                  silentLogger
                )
              )
            )
            if (liveSse) return response.status === 503
            if (bodyMode === "malformed" || emptyKeys) return response.status === 502
            if (validateMode === "defect") return response.status === 500
            if (validateMode === "denied") return response.status === 503
            if (bodyMode === "nullEntry" || (bodyMode === "missingKey" && rows.length > 0)) {
              return response.status === 502
            }
            const needsReplay = rows.some((r) => r.op !== "delete" && !r.allowed && r.retry)
            if (needsReplay) return response.status === 503
            if (response.status !== 200 || response.body._tag !== "Uint8Array") return false
            const out = JSON.parse(new TextDecoder().decode(response.body.body)) as Array<{
              readonly headers: { readonly operation?: string; readonly control?: string }
              readonly value?: Record<string, unknown>
            }>
            for (const msg of out) {
              if (msg.value === undefined) continue
              if (msg.headers.operation === "delete") {
                const keys = Object.keys(msg.value)
                if (keys.length !== 1 || keys[0] !== "id") return false
              } else if (msg.value["allowed"] !== true) return false
            }
            const expectedCount = rows.filter((r) => r.op === "delete" || r.allowed).length +
              (bodyMode === "withControl" ? 1 : 0)
            return out.length === expectedCount
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("SyncPolicy.retryAfterMs, backoff, respectingRetryAfter, and ShapeProxy.config obey bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        header: Schema.Union([
          Schema.Null,
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          Schema.Literals([
            "0",
            "5",
            "999999",
            "-1",
            "Wed, 21 Oct 2099 07:28:00 GMT",
            "Wed, 21 Oct 2000 07:28:00 GMT",
            "invalid",
            "   "
          ])
        ]),
        secretAs: Schema.Literals(["parameter", "bearer"]),
        retryAfterMs: Schema.Union([
          Schema.Undefined,
          Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })))
        ]),
        initialMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        maxMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 5, maximum: 20 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ header, secretAs, retryAfterMs, initialMs, maxMs }) =>
          Effect.gen(function*() {
            const ms = SyncPolicy.retryAfterMs(header, 1_700_000_000_000)
            if (ms !== undefined && (!Number.isFinite(ms) || ms < 0 || ms > SyncPolicy.MAX_RETRY_AFTER_MS)) return false
            const provider = ConfigProvider.fromUnknown({
              ELECTRIC_URL: "https://electric.internal",
              ELECTRIC_SECRET: "top-secret",
              ELECTRIC_SECRET_AS: secretAs,
              ELECTRIC_SOURCE_ID: "src-1"
            })
            const cfg = yield* ShapeProxy.config().pipe(Effect.provide(ConfigProvider.layer(provider)))
            if (cfg.url !== "https://electric.internal" || cfg.secretAs !== secretAs || cfg.sourceId !== "src-1") {
              return false
            }
            const base = SyncPolicy.backoff({ initial: Duration.millis(initialMs), max: Duration.millis(maxMs) })
            const policy = SyncPolicy.respectingRetryAfter(base)
            const step = yield* Schedule.toStep(policy)
            const [, delay] = yield* step(0, new ShapeSource.RequestFailed({ status: 503, retryAfterMs }))
            if (retryAfterMs !== undefined && Duration.toMillis(delay) < retryAfterMs) return false
            return Duration.toMillis(delay) >= 0
          }),
        { seed: seed + 2, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Batch.rowsIn validates all Electric wire envelopes and rejects malformed/partial batches", async () => {
    const msgArb = Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("change"),
        key: Schema.String.pipe(Schema.check(Schema.isMaxLength(12))),
        op: Schema.Literals(["insert", "update", "delete"]),
        hasTxids: Schema.Boolean,
        hasLsn: Schema.Boolean,
        hasOld: Schema.Boolean
      }),
      Schema.Struct({
        kind: Schema.Literal("control"),
        control: Schema.Literals(["up-to-date", "must-refetch", "snapshot-end", "subset-end"])
      }),
      Schema.Struct({
        kind: Schema.Literal("event"),
        event: Schema.Literals(["move-out", "move-in"]),
        pos: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })))
      }),
      Schema.Struct({
        kind: Schema.Literal("bad"),
        mode: Schema.Literals(["notRecord", "badHeaders", "badChange", "badControl", "badEvent"])
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        messages: Schema.Array(msgArb).pipe(Schema.check(Schema.isMaxLength(8))),
        corruptJson: Schema.Literals(["none", "truncated", "notArray"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ messages, corruptJson }) =>
          Effect.sync(() => {
            if (corruptJson === "truncated") return rowsIn("[{\"key\":") === undefined
            if (corruptJson === "notArray") return rowsIn("{\"hello\":1}") === undefined
            let expectedChanges = 0
            let hasBad = false
            const wire = messages.map((m) => {
              if (m.kind === "change") {
                expectedChanges++
                return {
                  key: m.key,
                  value: { id: m.key },
                  ...(m.hasOld ? { old_value: { id: m.key } } : {}),
                  headers: {
                    operation: m.op,
                    ...(m.hasTxids ? { txids: [1, 2] } : {}),
                    ...(m.hasLsn ? { lsn: "12345" } : {})
                  }
                }
              }
              if (m.kind === "control") {
                if (m.control === "snapshot-end") {
                  return { headers: { control: "snapshot-end", xmin: "1", xmax: "2", xip_list: ["1"] } }
                }
                if (m.control === "subset-end") {
                  return { headers: { control: "subset-end" } }
                }
                return { headers: { control: m.control, global_last_seen_lsn: "99" } }
              }
              if (m.kind === "event") {
                return { headers: { event: m.event, patterns: [{ pos: m.pos, value: "a" }] } }
              }
              hasBad = true
              switch (m.mode) {
                case "notRecord":
                  return 42
                case "badHeaders":
                  return { key: "k", headers: "bad" }
                case "badChange":
                  return { key: "k", value: "not-record", headers: { operation: "insert" } }
                case "badControl":
                  return { headers: { control: "unknown-ctrl" } }
                case "badEvent":
                  return { headers: { event: "unknown-event" } }
              }
            })
            const result = rowsIn(JSON.stringify(wire))
            return hasBad ? result === undefined : result === expectedChanges
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("fence.fenced blocks all writes and metadata mutations once closed while passing reads when open", async () => {
    const opArb = Schema.Literals([
      "begin",
      "write",
      "commit",
      "truncate",
      "colSet",
      "colDel",
      "rowSet",
      "rowDel",
      "close"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(20))),
        withMetadata: Schema.Boolean,
        withRowMetadata: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops, withMetadata, withRowMetadata }) =>
          Effect.sync(() => {
            let open = true
            let callsAfterClose = 0
            let callsWhileOpen = 0
            const track = () => {
              if (open) callsWhileOpen++
              else callsAfterClose++
            }
            const raw: SyncControls = {
              begin: track,
              write: () => track(),
              commit: () => {
                track()
                return "committed"
              },
              truncate: () => track(),
              ...(withMetadata
                ? {
                  metadata: {
                    collection: { set: () => track(), delete: () => track() },
                    ...(withRowMetadata ? { row: { set: () => track(), delete: () => track() } } : {})
                  }
                }
                : {})
            }
            const wrapped = fenced(raw, () => open)
            let expectedOpenCalls = 0
            for (const op of ops) {
              if (op === "close") {
                open = false
                continue
              }
              switch (op) {
                case "begin":
                  wrapped.begin()
                  if (open) expectedOpenCalls++
                  break
                case "write":
                  wrapped.write({} as never)
                  if (open) expectedOpenCalls++
                  break
                case "commit": {
                  const res = wrapped.commit()
                  if (open) {
                    expectedOpenCalls++
                    if (res !== "committed") return false
                  } else if (res !== true) {
                    return false
                  }
                  break
                }
                case "truncate":
                  wrapped.truncate()
                  if (open) expectedOpenCalls++
                  break
                case "colSet":
                  wrapped.metadata?.collection.set("k", 1)
                  if (open && withMetadata) expectedOpenCalls++
                  break
                case "colDel":
                  wrapped.metadata?.collection.delete("k")
                  if (open && withMetadata) expectedOpenCalls++
                  break
                case "rowSet":
                  wrapped.metadata?.row?.set("r", 1)
                  if (open && withMetadata && withRowMetadata) expectedOpenCalls++
                  break
                case "rowDel":
                  wrapped.metadata?.row?.delete("r")
                  if (open && withMetadata && withRowMetadata) expectedOpenCalls++
                  break
              }
            }
            return callsAfterClose === 0 && callsWhileOpen === expectedOpenCalls
          }),
        { seed: seed + 4, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ShapeSource fetchSource, gated, and layerFaulty enforce all switches, headers, and gating semantics", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fault: Schema.Literals(["healthy", "down", "refuse", "stall", "corrupt", "cut", "drop"]),
        requestsScope: Schema.Literals(["all", "live"]),
        isLiveUrl: Schema.Boolean,
        refuseStatus: Schema.Literals([400, 401, 403, 503]),
        cutBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        fetchFails: Schema.Boolean,
        withCallerSignal: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ fault, requestsScope, isLiveUrl, refuseStatus, cutBytes, fetchFails, withCallerSignal }) =>
          Effect.gen(function*() {
            let seenCache: string | undefined
            let seenPriority: string | undefined
            const stubFetch: typeof fetch = async (_input, init) => {
              seenCache = init?.cache
              seenPriority = (init as { readonly priority?: string } | undefined)?.priority
              if (fetchFails) throw new TypeError("network error")
              return new Response("[{\"headers\":{\"control\":\"up-to-date\"}}]", {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            }

            const url = isLiveUrl
              ? "https://electric.test/v1/shape?table=notes&live=true"
              : "https://electric.test/v1/shape?table=notes"
            const controller = new AbortController()
            const init: RequestInit = withCallerSignal ? { signal: controller.signal } : {}

            const directRes = yield* Effect.result(
              ShapeSource.fetchSource.request(url, init).pipe(
                Effect.provideService(FetchHttpClient.Fetch, stubFetch)
              )
            )
            if (fetchFails) {
              if (directRes._tag !== "Failure") return false
            } else {
              if (directRes._tag !== "Success" || seenCache !== "no-store") return false
              if (isLiveUrl && seenPriority !== "low") return false
              if (!isLiveUrl && seenPriority !== undefined) return false
            }

            const gatePubSub = yield* PubSub.unbounded<boolean>({ replay: 1 })
            yield* PubSub.publish(gatePubSub, false)
            const baseSource: ShapeSource.Source = {
              request: () =>
                Effect.succeed(new Response("[{\"headers\":{\"control\":\"up-to-date\"}}]", { status: 200 }))
            }
            const gatedSource = ShapeSource.gated(baseSource, Stream.fromPubSub(gatePubSub))
            const gatedFiber = yield* gatedSource.request(url, {}).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            yield* PubSub.publish(gatePubSub, true)
            const gatedRes = yield* Fiber.join(gatedFiber)
            if (gatedRes.status !== 200) return false

            const faultyProgram = Effect.gen(function*() {
              const faults = yield* ShapeSource.Faults
              const source = yield* ShapeSource.ShapeSource
              switch (fault) {
                case "down":
                  yield* faults.down(requestsScope)
                  break
                case "refuse":
                  yield* faults.refuse(refuseStatus, requestsScope)
                  break
                case "stall":
                  yield* faults.stall(requestsScope)
                  break
                case "corrupt":
                  yield* faults.corrupt(requestsScope)
                  break
                case "cut":
                  yield* faults.cut(cutBytes, requestsScope)
                  break
                case "drop":
                  yield* faults.drop(cutBytes, requestsScope)
                  break
                case "healthy":
                  break
              }
              const active = fault !== "healthy" && (requestsScope === "all" || isLiveUrl)
              if (fault === "stall" && active) {
                const reqFiber = yield* source.request(url, {}).pipe(Effect.forkChild)
                yield* Effect.yieldNow
                yield* faults.heal
                const res = yield* Fiber.join(reqFiber)
                const sent = yield* faults.sent
                return res.status === 200 && sent.length === 1
              }
              const res = yield* Effect.result(source.request(url, {}))
              const sent = yield* faults.sent
              if (sent.length !== 1) return false
              if (!active) {
                return res._tag === "Success" && res.success.status === 200
              }
              if (fault === "down") return res._tag === "Failure"
              if (res._tag !== "Success") return false
              if (fault === "refuse") return res.success.status === refuseStatus
              if (fault === "corrupt") {
                const text = yield* Effect.promise(() => res.success.text())
                return text === "[{"
              }
              if (fault === "cut") {
                const buf = yield* Effect.promise(() => res.success.arrayBuffer())
                return buf.byteLength === cutBytes
              }
              if (fault === "drop") {
                const readResult = yield* Effect.result(
                  Effect.tryPromise(() => res.success.arrayBuffer())
                )
                return readResult._tag === "Failure"
              }
              return true
            }).pipe(
              Effect.provide(ShapeSource.layerFaulty()),
              Effect.provideService(ShapeSource.ShapeSource, baseSource)
            )
            return yield* Effect.scoped(faultyProgram)
          }),
        { seed: seed + 5, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ElectricCollection syncs batches, handles 204/4xx/5xx/headless/corrupt/decode/reconnect/evict/mutations/statusOf", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "happy",
          "status204",
          "status204Headless",
          "retry503ThenOk",
          "retry429Exhausted",
          "stop403",
          "headless",
          "corruptBody",
          "badSchemaRow",
          "networkFailExhausted",
          "bodyDropThenOk",
          "progressive"
        ]),
        withNamespace: Schema.Boolean,
        rowCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, withNamespace, rowCount }) =>
          Effect.scoped(
            Effect.gen(function*() {
              let reqNum = 0
              const seenUrls: Array<string> = []
              const handle = "h-1"
              const initialRows: Array<Note> = Array.from({ length: rowCount }, (_, i) => ({
                id: `id-${i}`,
                text: `hello-${i}`,
                n: i + 1
              }))
              const initialBatch = [
                ...initialRows.map((r, i) => ({
                  key: `"notes"/"${r.id}"`,
                  value: { id: r.id, text: r.text, n: String(r.n) },
                  headers: { operation: "insert", txids: [100 + i] }
                })),
                { headers: { control: "up-to-date" } }
              ]

              const source: ShapeSource.Source = {
                ...(withNamespace ? { cacheNamespace: "realm-ns-1" } : {}),
                request: (url, init) =>
                  Effect.gen(function*() {
                    seenUrls.push(url)
                    const parsed = new URL(url)
                    const isLive = parsed.searchParams.get("live") === "true"
                    const isSubset = [...parsed.searchParams.keys()].some((k) => k.startsWith("subset__"))
                    const attemptIndex = ++reqNum
                    if (isSubset) {
                      return new Response(
                        JSON.stringify({
                          metadata: { snapshot_mark: 1, xmin: "1", xmax: "2", xip_list: [] },
                          data: []
                        }),
                        { status: 200, headers: electricHeaders(handle, "0_0", false) }
                      )
                    }
                    if (!isLive) {
                      if (mode === "status204") {
                        return new Response(null, { status: 204, headers: electricHeaders(handle, "0_0", false) })
                      }
                      if (mode === "status204Headless") {
                        return new Response(null, { status: 204 })
                      }
                      if (mode === "retry503ThenOk" && attemptIndex === 1) {
                        return new Response("busy", { status: 503, headers: { "retry-after": "0" } })
                      }
                      if (mode === "retry429Exhausted") {
                        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
                      }
                      if (mode === "stop403") {
                        return Response.json({ message: "forbidden" }, { status: 403 })
                      }
                      if (mode === "headless") {
                        return new Response(JSON.stringify(initialBatch), {
                          status: 200,
                          headers: { "content-type": "application/json" }
                        })
                      }
                      if (mode === "corruptBody") {
                        return new Response("[{bad", { status: 200, headers: electricHeaders(handle, "0_1", false) })
                      }
                      if (mode === "badSchemaRow" && attemptIndex === 1) {
                        const badBatch = [
                          {
                            key: "\"notes\"/\"bad\"",
                            value: { id: "bad", text: 12345, n: "not-a-number" },
                            headers: { operation: "insert" }
                          },
                          { headers: { control: "up-to-date" } }
                        ]
                        return new Response(JSON.stringify(badBatch), {
                          status: 200,
                          headers: electricHeaders(handle, "0_1", false)
                        })
                      }
                      if (mode === "networkFailExhausted") {
                        return yield* new ShapeSource.RequestFailed({})
                      }
                      if (mode === "bodyDropThenOk" && attemptIndex === 1) {
                        const broken = new ReadableStream<Uint8Array>({
                          pull(controller) {
                            controller.error(new TypeError("dropped"))
                          }
                        })
                        return new Response(broken, { status: 200, headers: electricHeaders(handle, "0_1", false) })
                      }
                      return new Response(JSON.stringify(initialBatch), {
                        status: 200,
                        headers: electricHeaders(handle, "0_1", false, { "electric-up-to-date": "" })
                      })
                    }
                    return yield* Effect.callback<Response, ShapeSource.RequestFailed>((resume) => {
                      const onAbort = () => resume(Effect.fail(new ShapeSource.RequestFailed({})))
                      if (init.signal?.aborted) {
                        onAbort()
                        return
                      }
                      init.signal?.addEventListener("abort", onAbort, { once: true })
                      return Effect.sync(() => init.signal?.removeEventListener("abort", onAbort))
                    })
                  })
              }

              const retry = mode === "retry429Exhausted" || mode === "networkFailExhausted"
                ? Schedule.recurs(1)
                : Schedule.spaced("1 millis")

              let insertedRows: Array<Note> = []
              let updatedRows: Array<Note> = []
              let deletedRows: Array<Note> = []

              const col = yield* ElectricCollection.make<Note, never>({
                id: `notes:${crypto.randomUUID()}`,
                schema: NoteSchema,
                getKey: (row) => row.id,
                shape: { url: "https://electric.test/v1/shape", params: { table: "notes" } },
                syncMode: mode === "progressive" ? "progressive" : "eager",
                retry,
                onInsert: ({ rows }) =>
                  Effect.sync(() => {
                    insertedRows = [...rows]
                  }),
                onUpdate: ({ rows }) =>
                  Effect.sync(() => {
                    updatedRows = [...rows]
                  }),
                onDelete: ({ rows }) =>
                  Effect.sync(() => {
                    deletedRows = [...rows]
                  })
              }).pipe(Effect.provideService(ShapeSource.ShapeSource, source))

              const events: Array<ElectricCollection.SyncEvent> = []
              yield* col.sync.pipe(
                Stream.runForEach((e) =>
                  Effect.sync(() => {
                    events.push(e)
                  })
                ),
                Effect.forkScoped({ startImmediately: true })
              )

              if (
                mode === "stop403" || mode === "retry429Exhausted" || mode === "headless" ||
                mode === "status204Headless" || mode === "corruptBody" || mode === "networkFailExhausted" ||
                mode === "badSchemaRow"
              ) {
                yield* col.preload.pipe(Effect.forkScoped)
                yield* Effect.suspend(() =>
                  events.some((e) => e._tag === "Stopped") ? Effect.void : Effect.fail("wait")
                ).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }), Effect.ignore)

                const stoppedEvent = events.find((e) => e._tag === "Stopped")
                if (stoppedEvent === undefined || stoppedEvent._tag !== "Stopped") return false
                const statusOpt = ElectricCollection.statusOf(stoppedEvent.error)
                if (mode === "stop403" && (!Option.isSome(statusOpt) || statusOpt.value !== 403)) return false
                if (mode === "retry429Exhausted" && (!Option.isSome(statusOpt) || statusOpt.value !== 429)) return false
                if (
                  (mode === "headless" || mode === "status204Headless" || mode === "corruptBody" ||
                    mode === "networkFailExhausted") &&
                  Option.isSome(statusOpt)
                ) {
                  return false
                }
                if (mode === "badSchemaRow") {
                  yield* col.reconnect
                  yield* Effect.suspend(() =>
                    events.some((e) => e._tag === "Succeeded") ? Effect.void : Effect.fail("wait")
                  ).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }), Effect.ignore)
                  return events.some((e) => e._tag === "Succeeded")
                }
                return true
              }

              if (mode === "status204" || mode === "progressive") {
                if (mode === "progressive") {
                  col.tanstack.startSyncImmediate()
                } else {
                  yield* col.preload.pipe(Effect.forkScoped)
                }
                yield* Effect.suspend(() =>
                  events.some((e) => e._tag === "Succeeded") ? Effect.void : Effect.fail("wait")
                ).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }), Effect.ignore)
                return events.some((e) => e._tag === "Succeeded")
              }

              yield* col.preload
              const rows = yield* col.toArray
              if (rows.length !== rowCount) return false

              for (const u of seenUrls) {
                if (new URL(u).searchParams.has("smithers-cache-namespace")) return false
              }

              if (mode === "happy") {
                yield* col.awaitTxId(100, "200 millis")
                yield* col.awaitMatch((c) => c.value.id === "id-0", "200 millis")
                const txTimeout = yield* Effect.result(col.awaitTxId(999999, "10 millis"))
                if (txTimeout._tag !== "Failure" || txTimeout.failure._tag !== "AwaitTimeout") return false
                const matchTimeout = yield* Effect.result(
                  col.awaitMatch((c) => c.value.id === "never-exists", "10 millis")
                )
                if (matchTimeout._tag !== "Failure" || matchTimeout.failure._tag !== "AwaitTimeout") return false

                col.tanstack.insert({ id: "local-1", text: "new", n: 99 })
                yield* Effect.sleep("10 millis")
                col.tanstack.update("id-0", (draft) => {
                  draft.text = "updated"
                })
                yield* Effect.sleep("10 millis")
                col.tanstack.delete("id-0")
                yield* Effect.sleep("10 millis")
                if (insertedRows.length !== 1 || updatedRows.length !== 1 || deletedRows.length !== 1) return false

                yield* col.evict
                yield* col.reconnect
              }

              const fetchErr = new FetchError(418, "teapot", undefined, {}, "https://electric.test")
              const s1 = ElectricCollection.statusOf(new Error("wrap", { cause: fetchErr }))
              const s2 = ElectricCollection.statusOf(
                new ElectricCollection.SyncFailed({ cause: new Error("x"), status: 502 })
              )
              const s3 = ElectricCollection.statusOf("not-an-object")
              return Option.isSome(s1) && s1.value === 418 && Option.isSome(s2) && s2.value === 502 && Option.isNone(s3)
            }).pipe(Effect.provide(silentLogger))
          ),
        { seed: seed + 6, executions: Math.min(executions, 24) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ElectricCollection with real SQLite Persistence restores, certifies currentApplied, and coordinates evict", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        evictBeforeLoad: Schema.Boolean,
        rowText: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(16)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ evictBeforeLoad, rowText }) => {
          const dbPath = join(tmpdir(), `electric-fuzz-${crypto.randomUUID()}.sqlite`)
          const device = `dev-${crypto.randomUUID()}`
          const makePersistence = () =>
            Persistence.layer({
              open: () => sqlite(dbPath),
              make: (database, coordinator) =>
                createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
              coordinator: () => new BrowserCollectionCoordinator({ dbName: device })
            })
          const batch = [
            {
              key: "\"notes\"/\"p1\"",
              value: { id: "p1", text: rowText, n: "1" },
              headers: { operation: "insert", txids: [1] }
            },
            { headers: { control: "up-to-date" } }
          ]
          // Once false the source answers nothing, as offline: no row comes back after an evict, so a row still held
          // then is one `evict` left behind.
          let serving = true
          const source: ShapeSource.Source = {
            request: (url, init) => {
              const parsed = new URL(url)
              const isLive = parsed.searchParams.get("live") === "true"
              if (!isLive && serving) {
                return Effect.succeed(
                  new Response(JSON.stringify(batch), {
                    status: 200,
                    headers: electricHeaders("h-persist", "0_1", false, { "electric-up-to-date": "" })
                  })
                )
              }
              return Effect.callback<Response, ShapeSource.RequestFailed>((resume) => {
                const onAbort = () => resume(Effect.fail(new ShapeSource.RequestFailed({})))
                if (init.signal?.aborted) {
                  onAbort()
                  return
                }
                init.signal?.addEventListener("abort", onAbort, { once: true })
                return Effect.sync(() => init.signal?.removeEventListener("abort", onAbort))
              })
            }
          }
          const colId = `notes-persist-${crypto.randomUUID()}`
          type Notes = ElectricCollection.ElectricCollection<Note>
          // One program over the device's database: its collection, closed with the program.
          // A failed restore or preload fails the property, like a row that is wrong.
          const program = <E>(body: (col: Notes) => Effect.Effect<boolean, E>) =>
            Effect.scoped(
              Effect.flatMap(
                ElectricCollection.make<Note, never>({
                  id: colId,
                  schema: NoteSchema,
                  getKey: (r) => r.id,
                  shape: { url: "https://electric.test/v1/shape", params: { table: "notes" } },
                  persist: { schemaVersion: 1 },
                  retry: Schedule.spaced("5 millis")
                }),
                body
              )
            ).pipe(
              Effect.orElseSucceed(() => false),
              Effect.provide(makePersistence()),
              Effect.provideService(ShapeSource.ShapeSource, source),
              Effect.provide(silentLogger)
            )
          const holds = (col: Notes, expected: ReadonlyArray<string>) =>
            Effect.map(col.toArray, (rows) => JSON.stringify(rows.map((row) => row.text)) === JSON.stringify(expected))
          // A persisted collection's rows leave it, and the device, as the evicting transaction arrives; one that
          // never arrives (an `evict` that truncates nothing) ends the wait and fails the property.
          const emptied = (col: Notes) =>
            eventually(() => col.tanstack.size === 0 && storedRows(dbPath, colId) === 0).pipe(
              Effect.andThen(holds(col, [])),
              Effect.catchDefect(() => Effect.succeed(false))
            )
          return Effect.gen(function*() {
            // The first program syncs the row and certifies it applied. Unless the next program is to evict unread,
            // it evicts what it holds, with the source silent: the row must be gone, not merely about to return.
            const synced = yield* program((col) =>
              Effect.gen(function*() {
                const appliedFiber = yield* col.currentApplied.pipe(Effect.forkScoped({ startImmediately: true }))
                yield* col.preload
                yield* Fiber.join(appliedFiber).pipe(Effect.timeout("1 second"), Effect.ignore)
                if (!(yield* holds(col, [rowText]))) return false
                serving = false
                if (evictBeforeLoad) {
                  // The row reaches the device after it is applied; the next programs start from what is stored.
                  return yield* eventually(() => storedRows(dbPath, colId) === 1).pipe(
                    Effect.as(true),
                    Effect.catchDefect(() => Effect.succeed(false))
                  )
                }
                yield* col.evict
                return yield* emptied(col)
              }).pipe(Effect.scoped)
            )
            if (!synced) return false
            if (evictBeforeLoad) {
              // The device kept the row: an offline program restores it. The next one evicts before anything reads.
              if (!(yield* program((col) => Effect.andThen(col.restored, holds(col, [rowText]))))) return false
              if (!(yield* program((col) => Effect.andThen(col.evict, emptied(col))))) return false
            }
            // The rows left the device too: an offline program restores nothing.
            return yield* program((col) => Effect.andThen(col.restored, holds(col, [])))
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                for (const suffix of ["", "-wal", "-shm"]) {
                  try {
                    rmSync(`${dbPath}${suffix}`, { force: true })
                  } catch {
                    // ignore
                  }
                }
              })
            )
          )
        },
        { seed: seed + 7, executions: Math.min(executions, 6) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
