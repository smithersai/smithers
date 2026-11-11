import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { createServer, request as httpsRequest } from "node:https"
import { describe, expect, it } from "vitest"
import { layerNoop } from "../src/Control.ts"
import { layerNoopAuth } from "../src/ControlRpcs.ts"
import * as ControlServer from "../src/ControlServer.ts"
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
  it.each([undefined, "http:", "https:"] as const)(
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

  it.each([undefined, "http:", "https:"] as const)(
    "requires trusted fallback metadata when the request URL is relative (%s)",
    async (scheme) => {
      // A host whose adapter supplies only a relative URL. Keep every other
      // request field and the real router and RPC handlers intact.
      const relative = HttpRouter.middleware((httpEffect) =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const withoutScheme = Object.create(request) as HttpServerRequest.HttpServerRequest
          Object.defineProperty(withoutScheme, "originalUrl", { value: "/rpc" })
          return yield* httpEffect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, withoutScheme))
        })
      ).layer
      await Effect.runPromise(Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            ControlServer.layerHttp.pipe(
              Layer.provide([
                layerNoop,
                layerNoopAuth(),
                RpcSerialization.layerNdjson,
                Layer.succeed(ControlServer.RequestScheme, scheme)
              ]),
              Layer.provide(relative)
            ),
            { disableLogger: true }
          )
        ),
        ({ handler }) =>
          Effect.gen(function*() {
            for (const originScheme of ["http:", "https:"] as const) {
              // The forwarding header never supplies the missing scheme.
              const response = yield* Effect.promise(() =>
                handler(request("https://control.example/rpc", `${originScheme}//control.example`, "https"))
              )
              expect([originScheme, response.status]).toEqual([originScheme, originScheme === scheme ? 200 : 403])
              yield* Effect.promise(() => response.text())
            }
          }),
        ({ dispose }) => Effect.promise(dispose)
      ))
    }
  )

  it("refuses an https origin from another host on direct TLS with no configured scheme", async () => {
    const server = HttpRouter.serve(
      ControlServer.layerHttp.pipe(Layer.provide([
        layerNoop,
        layerNoopAuth(),
        RpcSerialization.layerNdjson,
        Layer.succeed(ControlServer.RequestScheme, undefined)
      ])),
      { disableListenLog: true, disableLogger: true }
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(() => createServer({ key, cert }), { host: "127.0.0.1", port: 0 })))
    await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        if (server.address._tag !== "InetAddressV4") return yield* Effect.die("expected TCP")
        const port = server.address.port
        for (
          const [origin, expected] of [
            [`https://127.0.0.1:${port}`, 200],
            [`https://attacker.example:${port}`, 403],
            [`https://127.0.0.1:${port + 1}`, 403]
          ] as const
        ) {
          const status = yield* Effect.callback<number>((resume) => {
            const outgoing = httpsRequest({
              hostname: "127.0.0.1",
              port,
              path: "/rpc",
              method: "POST",
              rejectUnauthorized: false,
              headers: { origin, "content-type": "application/ndjson" }
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
          expect([origin, status]).toEqual([origin, expected])
        }
      }).pipe(Effect.provide(server), Effect.scoped)
    )
  })

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
