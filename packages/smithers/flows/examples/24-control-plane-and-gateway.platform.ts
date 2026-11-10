// The platform code of 24-control-plane-and-gateway.vibe, which a .vibe file does not import as a value (EK4402).

import { NodeHttpServer, NodeWS } from "@effect/platform-node"
import * as ControlRpcs from "@smthrs/control/ControlRpcs"
import * as ControlServer from "@smthrs/control/ControlServer"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import * as Effect from "effect/Effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Layer from "effect/Layer"
import { RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The project whose `.smithers/flows/` directory the control plane serves. */
export const projectRoot: string = join(dirname(fileURLToPath(import.meta.url)), "24-project")

/** The base URL of a listening TCP server. */
const addressOf = (server: HttpServer.HttpServer["Service"]): string => {
  const address = server.address
  if (address._tag !== "InetAddressV4") throw new Error("expected a TCP control server")
  return `http://127.0.0.1:${address.port}`
}

/** Mounts both control RPC transports on an ephemeral loopback server. */
export const serve = (credential: string) =>
  HttpRouter.serve(
    ControlServer.layerHttp.pipe(
      Layer.provide(Layer.succeed(ControlServer.RequestScheme, "http:")),
      Layer.provide(ControlRpcs.layerBearerAuth({ token: credential, principal: { id: "local", kind: "operator" } })),
      Layer.provide(
        HttpRouter.middleware(Effect.gen(function*() {
          const server = yield* HttpServer.HttpServer
          const origin = addressOf(server)
          const host = new URL(origin).host
          return (handler) =>
            Effect.gen(function*() {
              const request = yield* HttpServerRequest.HttpServerRequest
              // Check before routing, including before the WebSocket upgrade. Native
              // clients may omit Origin; browser origins must match this exact server.
              if (
                request.headers.host !== host ||
                (request.headers.origin !== undefined && request.headers.origin !== origin)
              ) {
                return HttpServerResponse.empty({ status: 403 })
              }
              return yield* handler
            })
        })).layer
      ),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
    )
  )

/** The base URL the server in context listens on. */
export const listeningUrl = Effect.gen(function*() {
  const server = yield* HttpServer.HttpServer
  return addressOf(server)
})

/**
 * A file the example keeps under `root`.
 *
 * @throws {never}
 */
export const inRoot = (root: string, name: string): string => join(root, name)

/** Creates `root`, the directory the two SQLite files are created in. */
export const ensureDirectory = (root: string) => Effect.sync(() => mkdirSync(root, { recursive: true }))

/** A fresh session bearer credential. */
export const newCredential = Effect.sync(() => randomBytes(32).toString("hex"))

/** The client's two transports to the server at `url`: HTTP RPC for unary calls, WebSocket RPC for the watch. */
export const clientTransports = (url: string, credential: string) =>
  Layer.mergeAll(
    EgressHttpClient.layer(process.env),
    // This Node client can put the credential on the upgrade request.
    // Browser WebSocket constructors cannot set Authorization headers.
    Socket.layerWebSocket(`ws://127.0.0.1:${new URL(url).port}/rpc/ws`).pipe(
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (url, options) => {
            // A constructor receives either a protocol list or Node client options.
            const configured = options !== undefined && typeof options !== "string" && !Array.isArray(options)
              ? options
              : undefined
            const protocols = configured === undefined
              ? options as string | Array<string> | undefined
              : undefined
            return new NodeWS.WebSocket(url, protocols, {
              ...configured,
              headers: { ...configured?.headers, authorization: `Bearer ${credential}` }
            }) as unknown as globalThis.WebSocket
          }
        )
      )
    ),
    RpcSerialization.layerNdjson
  )
