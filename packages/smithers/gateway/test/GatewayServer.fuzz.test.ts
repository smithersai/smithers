import { Unauthorized } from "@smthrs/control/ControlError"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { describe, expect, it } from "vitest"
import * as GatewayServer from "../src/GatewayServer.ts"
import * as HostBranchPresence from "../src/HostBranchPresence.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const health: GatewayServer.Health = {
  workspaceHash: "ws-fuzz-hash",
  gatewayId: "gw-fuzz-1",
  protocolVersion: "1",
  version: "1.0.0-rc.0"
}

describe("@smthrs/gateway GatewayServer ingress, ticket replay, body bounds, RPC framing & HostBranchPresence fuzz invariants", () => {
  it("routedPath, carriesRpcRequest, exceededBodyLimit & bodyRefusal uphold security normalization & framing invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rawPath: Schema.Literals([
          "/rpc",
          "/RPC/",
          "//rpc//",
          "/rpc?foo=1#bar",
          "/rpc;jsessionid=123",
          "/%72pc",
          "/%2572pc",
          "/%ZZbad",
          "http://127.0.0.1:8080/projections/ws/?ticket=abc",
          "/health",
          "/"
        ]),
        body: Schema.Literals([
          "",
          "{}",
          "[]",
          "not json at all",
          "{\"_tag\":\"Ping\"}",
          "[{\"_tag\":\"Request\",\"id\":\"1\"}]",
          "[{\"noTag\":true}]"
        ]),
        maxBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 16, maximum: 4096 }))),
        isLimitErr: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rawPath, body, maxBytes, isLimitErr }) =>
          Effect.gen(function*() {
            const routed = GatewayServer.routedPath(rawPath)
            if (routed !== routed.toLowerCase()) return false
            if (routed.length > 1 && routed.endsWith("/") && !rawPath.includes("%ZZ")) return false
            if (rawPath === "/RPC/" || rawPath === "//rpc//" || rawPath === "/rpc?foo=1#bar" || rawPath === "/rpc;jsessionid=123" || rawPath === "/%72pc") {
              if (routed !== "/rpc") return false
            }
            if (rawPath === "http://127.0.0.1:8080/projections/ws/?ticket=abc") {
              if (routed !== "/projections/ws") return false
            }
            if (rawPath === "/%2572pc" && routed === "/rpc") return false

            const jsonSer = yield* RpcSerialization.RpcSerialization.pipe(Effect.provide(RpcSerialization.layerJson))
            const carries = GatewayServer.carriesRpcRequest(jsonSer, body)
            const expectValid = body.includes("\"_tag\"")
            if (carries !== expectValid) return false

            const binSer = { ...jsonSer, contentType: "application/msgpack" }
            if (!GatewayServer.carriesRpcRequest(binSer, body)) return false

            const err = isLimitErr
              ? { reason: { cause: new Error("maxBytes exceeded") } }
              : new Error("socket reset")
            const refusal = GatewayServer.bodyRefusal("/rpc", maxBytes, err)
            if (isLimitErr) {
              if (!GatewayServer.exceededBodyLimit(err) || refusal.status !== 413 || refusal.error.code !== "request_too_large") {
                return false
              }
            } else {
              if (GatewayServer.exceededBodyLimit(err) || refusal.status !== 400 || refusal.error.code !== "malformed_request") {
                return false
              }
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("layerIngress + layerHealth enforce Host/Origin DNS-rebinding checks, single-use WS tickets, body limits & RPC framing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        host: Schema.Literals(["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "evil.example.com"]),
        origin: Schema.Literals(["", "http://localhost:3000", "https://evil.example.com"]),
        hasAuth: Schema.Boolean,
        rpcPayloadKind: Schema.Literals(["valid", "empty", "untagged", "oversized"]),
        wsPath: Schema.Literals(["/rpc/ws", "/projections/ws", "/sync/ws"])
      })
    )

    const okRoutes = Layer.mergeAll(
      GatewayServer.layerHealth(health),
      HttpRouter.add("POST", "/rpc", HttpServerResponse.text("ok")),
      HttpRouter.add("POST", "/projections", HttpServerResponse.text("proj-ok")),
      HttpRouter.add("GET", "/rpc/ws", HttpServerResponse.text("ws-ok")),
      HttpRouter.add("GET", "/projections/ws", HttpServerResponse.text("ws-ok")),
      HttpRouter.add("GET", "/sync/ws", HttpServerResponse.text("ws-ok"))
    )
    const ingressLayer = Layer.mergeAll(
      okRoutes,
      GatewayServer.layerIngress({
        loopbackOnly: true,
        maxRequestBodyBytes: 64,
        ticketMillis: 5_000,
        authorize: (headers) => Effect.succeed(headers.authorization === "Bearer secret-gw-token")
      }),
      HostBranchPresence.layer({
        runtimeArtifactDigest: "fuzz-digest",
        sourceRevision: "fuzz-rev",
        ownerGeneration: 1,
        authenticate: (headers) =>
          headers.authorization === "Bearer secret-gw-token"
            ? Effect.succeed({ id: "fuzz-actor", kind: "bearer", stampedAt: 0 })
            : Effect.fail(new Unauthorized({ message: "unauth" }))
      })
    ).pipe(
      Layer.provide(Layer.mergeAll(RpcSerialization.layerJson, Logger.layer([])))
    )

    const { handler, dispose } = HttpRouter.toWebHandler(ingressLayer)
    try {
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ host, origin, hasAuth, rpcPayloadKind, wsPath }) =>
            Effect.promise(async () => {
              const baseHeaders: Record<string, string> = { host }
              if (origin.length > 0) baseHeaders["origin"] = origin
              if (hasAuth) baseHeaders["authorization"] = "Bearer secret-gw-token"

              const badHost = host === "evil.example.com"
              const badOrigin = origin.length > 0 && new URL(origin).host !== host
              const expectedBlock = badHost ? 421 : badOrigin ? 403 : 0

              // 1. Health endpoint
              const healthResp = await handler(new Request("http://127.0.0.1:3000/health", { headers: baseHeaders }))
              if (expectedBlock !== 0) {
                if (healthResp.status !== expectedBlock) return false
              } else {
                if (healthResp.status !== 200) return false
              }

              // 2a. Edge-protected /projections POST: auth + body size + RPC framing
              const rpcBody = rpcPayloadKind === "valid"
                ? JSON.stringify({ _tag: "Ping" })
                : rpcPayloadKind === "empty"
                ? ""
                : rpcPayloadKind === "untagged"
                ? "{}"
                : "x".repeat(200)
              const projResp = await handler(
                new Request("http://127.0.0.1:3000/projections", {
                  method: "POST",
                  headers: { ...baseHeaders, "content-type": "application/json" },
                  body: rpcBody
                })
              )
              if (expectedBlock !== 0) {
                if (projResp.status !== expectedBlock) return false
              } else if (!hasAuth) {
                if (projResp.status !== 401) return false
              } else if (rpcPayloadKind === "oversized") {
                if (projResp.status !== 413) return false
              } else if (rpcPayloadKind === "valid") {
                if (projResp.status !== 200) return false
              } else {
                if (projResp.status !== 400) return false
              }

              // 2b. /rpc POST: in-band auth (not edge 401), still enforces body limit + RPC framing
              const rpcResp = await handler(
                new Request("http://127.0.0.1:3000/rpc", {
                  method: "POST",
                  headers: { ...baseHeaders, "content-type": "application/json" },
                  body: rpcBody
                })
              )
              if (expectedBlock !== 0) {
                if (rpcResp.status !== expectedBlock) return false
              } else if (rpcPayloadKind === "oversized") {
                if (rpcResp.status !== 413) return false
              } else if (rpcPayloadKind === "valid") {
                if (rpcResp.status !== 200) return false
              } else {
                if (rpcResp.status !== 400) return false
              }

              // 3. Single-use WebSocket ticket issuance & replay refusal
              const ticketResp = await handler(
                new Request("http://127.0.0.1:3000/auth/ticket", {
                  method: "POST",
                  headers: baseHeaders
                })
              )
              if (expectedBlock !== 0) {
                if (ticketResp.status !== expectedBlock) return false
              } else if (!hasAuth) {
                if (ticketResp.status !== 401) return false
              } else {
                if (ticketResp.status !== 200) return false
                const issued = await ticketResp.json() as { ticket: string; expiresInMs: number }
                if (typeof issued.ticket !== "string" || issued.ticket.length !== 64) return false

                // First redemption without Authorization header must succeed
                const wsHeaders: Record<string, string> = { host }
                if (origin.length > 0) wsHeaders["origin"] = origin
                const ws1 = await handler(
                  new Request(`http://127.0.0.1:3000${wsPath}?ticket=${issued.ticket}`, { headers: wsHeaders })
                )
                if (ws1.status !== 200) return false

                // Second redemption (replay!) must be refused 401
                const ws2 = await handler(
                  new Request(`http://127.0.0.1:3000${wsPath}?ticket=${issued.ticket}`, { headers: wsHeaders })
                )
                if (ws2.status !== 401) return false
              }

              return true
            }),
          { seed: seed + 1, executions: Math.min(executions, 80) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await dispose()
    }
  })
})
