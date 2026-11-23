import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { ShapeProxy } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

describe("@smthrs/effect-electric ShapeProxy security fuzz invariants", () => {
  it("pins server table/where/params, strips subset__* & unknown params, enforces no-store & SSE refusal, and never calls upstream on refusal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        attackerTable: Schema.Literals(["users", "secrets", "tokens", "messages"]),
        attackerWhere: Schema.Literals(["1=1", "true", "org_id='other'"]),
        subsetKey: Schema.Literals(["subset__where", "subset__limit", "subset__offset", "offset", "cursor"]),
        subsetVal: Schema.Literals(["-1", "0_0", "1=1", "100"]),
        secretAs: Schema.Literals(["parameter", "bearer"]),
        liveSse: Schema.Boolean,
        shouldRefuse: Schema.Boolean,
        refuseStatus: Schema.Literals([401, 403, 503])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ attackerTable, attackerWhere, subsetKey, subsetVal, secretAs, liveSse, shouldRefuse, refuseStatus }) =>
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
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response("[]", {
                    status: 200,
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
              where: attackerWhere,
              [subsetKey]: subsetVal,
              secret: "attacker-secret",
              source_id: "attacker-source",
              "params[1]": "evil-tenant",
              columns: "id,password_hash"
            })
            if (liveSse) qs.set("live_sse", "true")
            const webReq = new Request(`https://app.example/api/shape?${qs.toString()}`)
            const serverReq = HttpServerRequest.fromWeb(webReq)

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

            // SSE on no-store is ALWAYS refused before calling upstream.
            if (liveSse && !shouldRefuse) {
              return !upstreamCalled && response.status === 400
            }
            if (shouldRefuse) {
              if (upstreamCalled) return false
              if (response.status !== refuseStatus && !(liveSse && response.status === 400)) return false
              return true
            }
            if (!upstreamCalled || seenUrl === undefined) return false

            // Security invariant 1: pinned table, where, params, columns, source_id ALWAYS win.
            if (seenUrl.searchParams.get("table") !== "public.pinned_items") return false
            if (seenUrl.searchParams.get("where") !== "tenant_id = $1") return false
            if (seenUrl.searchParams.get("params[1]") !== "tenant-pinned") return false
            if (seenUrl.searchParams.get("columns") !== "id,title") return false
            if (seenUrl.searchParams.get("source_id") !== "server-source") return false

            // Security invariant 2: secret follows secretAs and NEVER uses attacker secret.
            if (secretAs === "parameter") {
              if (seenUrl.searchParams.get("secret") !== "server-only-secret") return false
              if (seenAuth !== undefined) return false
            } else {
              if (seenUrl.searchParams.has("secret")) return false
              if (seenAuth !== "Bearer server-only-secret") return false
            }

            // Security invariant 3: subset__* params are ALWAYS stripped.
            for (const key of seenUrl.searchParams.keys()) {
              if (key.startsWith("subset__")) return false
            }

            // Security invariant 4: no-store responses strip upstream etag & force private, no-store.
            const cc = response.headers["cache-control"] ?? ""
            if (!cc.includes("no-store")) return false
            if (response.headers["etag"] !== undefined) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("rowAccess filters unauthorized rows, strips non-key fields on delete, and forces 503 replay when required", async () => {
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
        validateOk: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rows, validateOk }) =>
          Effect.gen(function*() {
            const payload = rows.map((r) => ({
              headers: { operation: r.op },
              value: {
                id: String(r.id),
                allowed: r.allowed,
                retry: r.retry,
                secretField: r.secretField
              }
            }))
            const fakeClient = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { "content-type": "application/json" }
                  })
                )
              )
            )
            const serverReq = HttpServerRequest.fromWeb(new Request("https://app.example/api/shape?offset=-1"))
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

            if (!validateOk) {
              return response.status === 503
            }
            const needsReplay = rows.some((r) => r.op !== "delete" && !r.allowed && r.retry)
            if (needsReplay) {
              return response.status === 503
            }
            if (response.status !== 200) return false
            if (response.body._tag !== "Uint8Array") return false
            const out = JSON.parse(new TextDecoder().decode(response.body.body)) as Array<{
              readonly headers: { readonly operation: string }
              readonly value: Record<string, unknown>
            }>
            for (const msg of out) {
              if (msg.headers.operation === "delete") {
                // Deletes MUST only carry keyColumns, never secretField!
                const keys = Object.keys(msg.value)
                if (keys.length !== 1 || keys[0] !== "id") return false
              } else {
                if (msg.value["allowed"] !== true) return false
              }
            }
            const expectedCount = rows.filter((r) => r.op === "delete" || r.allowed).length
            return out.length === expectedCount
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
