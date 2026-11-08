import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { createServer, request as httpsRequest } from "node:https"
import { describe, expect, it } from "vitest"
import { layerNoop } from "../src/Control.vibe"
import { layerNoopAuth } from "../src/ControlRpcs.vibe"
import * as ControlServer from "../src/ControlServer.vibe"
import { cert, key } from "./fixtures/controlTls.ts"

const request = (url: string, origin?: string, forwardedProto?: string) =>
  new Request(url, {
    method: "POST",
    headers: {
      host: "control.example",
      "content-type": "application/ndjson",
      ...(origin === undefined ? {} : { origin }),
      ...(forwardedProto === undefined ? {} : { "x-forwarded-proto": forwardedProto })
    },
    body: `${JSON.stringify({ _tag: "Request", id: "1", tag: "List", payload: { _tag: "runs" }, headers: [] })}\n`
  })

describe("control browser origin", () => {
  it.each([undefined, "https:"] as const)(
    "guards the absolute TLS transport URL with external scheme %s",
    async (scheme) => {
      const server = HttpRouter.serve(
        ControlServer.layerHttp.pipe(Layer.provide([
          layerNoop,
          layerNoopAuth(),
          RpcSerialization.layerNdjson,
          Layer.succeed(ControlServer.RequestScheme, scheme)
        ])),
        { disableListenLog: true, disableLogger: true }
      ).pipe(Layer.provideMerge(NodeHttpServer.layer(() =>
        createServer({
          key,
          cert
        }), { host: "127.0.0.1", port: 0 })))
      await Effect.runPromise(
        Effect.gen(function*() {
          const server = yield* HttpServer.HttpServer
          if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected TCP")
          const port = server.address.port
          for (const originScheme of ["http:", "https:"]) {
            const status = yield* Effect.callback<number>((resume) => {
              const outgoing = httpsRequest({
                hostname: "127.0.0.1",
                port,
                path: "/rpc",
                method: "POST",
                rejectUnauthorized: false,
                headers: {
                  origin: `${originScheme}//127.0.0.1:${port}`,
                  "content-type": "application/ndjson",
                  // Forwarded headers do not supply missing or override configured metadata.
                  "x-forwarded-proto": originScheme.slice(0, -1)
                }
              }, (response) => {
                response.resume()
                resume(Effect.succeed(response.statusCode ?? 0))
              })
              outgoing.on("error", (error) => resume(Effect.die(error)))
              outgoing.end(
                `${JSON.stringify({ _tag: "Request", id: "1", tag: "List", payload: { _tag: "runs" }, headers: [] })}\n`
              )
              return Effect.sync(() => outgoing.destroy())
            })
            expect([originScheme, status]).toEqual([originScheme, (scheme ?? "https:") === originScheme ? 200 : 403])
          }
        }).pipe(Effect.provide(server), Effect.scoped)
      )
    }
  )

  it("requires the endpoint scheme as well as host and port", async () => {
    await Effect.runPromise(Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          ControlServer.layerHttp.pipe(
            Layer.provide([layerNoop, layerNoopAuth(), RpcSerialization.layerNdjson])
          ),
          { disableLogger: true }
        )
      ),
      ({ handler }) =>
        Effect.gen(function*() {
          for (
            const [url, origin, status] of [
              ["https://control.example/rpc", "http://control.example", 403],
              ["http://control.example/rpc", "https://control.example", 403],
              ["https://control.example/rpc", "https://control.example", 200],
              ["http://control.example/rpc", "http://control.example", 200],
              ["https://control.example/rpc", undefined, 200],
              ["https://control.example/rpc", "https://other.example", 403],
              ["https://control.example/rpc", "null", 403]
            ] as const
          ) {
            const response = yield* Effect.promise(() => handler(request(url, origin)))
            expect([url, origin, response.status]).toEqual([url, origin, status])
            yield* Effect.promise(() => response.text())
          }
          // An absolute Web request is authoritative even with an untrusted forwarding header.
          const response = yield* Effect.promise(() =>
            handler(request("https://control.example/rpc", "http://control.example", "http"))
          )
          expect(response.status).toBe(403)
          yield* Effect.promise(() => response.text())
        }),
      ({ dispose }) => Effect.promise(dispose)
    ))
  })
})
