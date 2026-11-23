import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Layer, Logger, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { ShapeProxy, SyncPolicy } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "800" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

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
                  new Response(upstreamStatus === 304 ? null : "[]", {
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
            // Upstream 401/403/302 MUST become outward 503 (never leak Electric auth/redirect to browser!)
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

  it("rowAccess filters unauthorized rows, strips non-key fields on delete, and forces 503 replay/SSE refusal", async () => {
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
        validateOk: Schema.Boolean,
        liveSse: Schema.Boolean,
        malformedBody: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rows, validateOk, liveSse, malformedBody }) =>
          Effect.gen(function*() {
            const payload = rows.map((r) => ({
              headers: { operation: r.op },
              value: { id: String(r.id), allowed: r.allowed, retry: r.retry, secretField: r.secretField }
            }))
            const fakeClient = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(malformedBody ? "not-json" : JSON.stringify(payload), {
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
            const response = yield* ShapeProxy.make({
              url: "https://electric.internal",
              shape: { table: "public.items" },
              rowAccess: {
                keyColumns: ["id"],
                allows: (v) => v["allowed"] === true,
                retryIfDenied: (v) => v["retry"] === true,
                validate: Effect.succeed(validateOk)
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
            if (malformedBody) return response.status === 502
            if (!validateOk) return response.status === 503
            const needsReplay = rows.some((r) => r.op !== "delete" && !r.allowed && r.retry)
            if (needsReplay) return response.status === 503
            if (response.status !== 200 || response.body._tag !== "Uint8Array") return false
            const out = JSON.parse(new TextDecoder().decode(response.body.body)) as Array<{
              readonly headers: { readonly operation: string }
              readonly value: Record<string, unknown>
            }>
            for (const msg of out) {
              if (msg.headers.operation === "delete") {
                const keys = Object.keys(msg.value)
                if (keys.length !== 1 || keys[0] !== "id") return false
              } else if (msg.value["allowed"] !== true) return false
            }
            return out.length === rows.filter((r) => r.op === "delete" || r.allowed).length
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("SyncPolicy.retryAfterMs & ShapeProxy.config parse bounded values cleanly without throwing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        header: Schema.Union([
          Schema.Null,
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          Schema.Literals(["0", "5", "999999", "-1", "Wed, 21 Oct 2099 07:28:00 GMT", "invalid"])
        ]),
        secretAs: Schema.Literals(["parameter", "bearer"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ header, secretAs }) =>
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
            return cfg.url === "https://electric.internal" && cfg.secretAs === secretAs && cfg.sourceId === "src-1"
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
