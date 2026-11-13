/** Fault injection at the Bun server boundary; the real runtime is covered by BunGateway.test. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import { HttpServer } from "effect/http"
import { createServer } from "node:http"
import { expect, it } from "vitest"
import * as BunGateway from "../src/bun/BunGateway.ts"
import { makeBunLayer } from "../src/internal/BunGateway.ts"
import { stack } from "./GatewayStack.ts"

const health = { workspaceHash: "adapter-workspace", gatewayId: "adapter", protocolVersion: "1", version: "1" }
const served = (server: Parameters<typeof makeBunLayer>[0], options?: BunGateway.ServerOptions) =>
  makeBunLayer(server)(health, options).pipe(Layer.provideMerge(stack()))

it("applies the shared bind policy before opening a Bun server", async () => {
  const failure = await Effect.runPromise(
    Layer.build(
      BunGateway.layer(health, { host: "0.0.0.0" }).pipe(Layer.provideMerge(stack()))
    ).pipe(Effect.flip, Effect.scoped)
  )
  expect(failure).toMatchObject({ code: "bind_failed", message: expect.stringContaining("--listen") })
})

it("serves the gateway through the supplied Bun address options", async () => {
  const addresses: Array<unknown> = []
  const server: Parameters<typeof makeBunLayer>[0] = (options) => {
    addresses.push(options)
    return NodeHttpServer.layerServer(createServer, { host: options.hostname, port: options.port })
  }
  await Effect.runPromise(
    Effect.gen(function*() {
      const context = yield* Layer.build(served(server, { port: 0 }))
      const http = yield* HttpServer.HttpServer.pipe(Effect.provide(context))
      if (http.address._tag !== "InetAddressV4") throw new Error("expected a TCP address")
      const url = `http://127.0.0.1:${http.address.port}/health`
      const response = yield* Effect.promise(() => fetch(url))
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject(health)
      expect(addresses).toEqual([{ hostname: "127.0.0.1", port: 0 }])
    }).pipe(Effect.scoped)
  )
})

for (const code of ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"]) {
  it(`sanitizes Bun's ${code} bind defect`, async () => {
    const server = () => Layer.effect(HttpServer.HttpServer, Effect.die({ code, message: "private socket details" }))
    const logged: Array<unknown> = []
    const failure = await Effect.runPromise(
      Layer.build(served(server, { host: "localhost", port: 0 })).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Logger.layer([Logger.make(({ message }) => {
          logged.push(message)
        })]))
      )
    )
    expect(failure).toMatchObject({ code: "bind_failed", message: "The gateway socket could not be bound" })
    expect(JSON.stringify(failure)).not.toContain("private socket details")
    expect(JSON.stringify(failure)).not.toContain(code)
    // The operator log keeps the operating-system cause the wire error omits.
    expect(JSON.stringify(logged)).toContain(code)
  })
}

for (const defect of ["unexpected defect", null, { message: "no code" }, { code: "UNKNOWN" }]) {
  it(`preserves an unexpected server defect: ${JSON.stringify(defect)}`, async () => {
    const addresses: Array<unknown> = []
    const server: Parameters<typeof makeBunLayer>[0] = (options) => {
      addresses.push(options)
      return Layer.effect(HttpServer.HttpServer, Effect.die(defect))
    }
    const exit = await Effect.runPromiseExit(Layer.build(served(server, {})).pipe(Effect.scoped))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
    expect(addresses).toEqual([{ hostname: "127.0.0.1", port: 7331 }])
  })
}

it("preserves interrupted startup with default options", async () => {
  const addresses: Array<unknown> = []
  const server: Parameters<typeof makeBunLayer>[0] = (options) => {
    addresses.push(options)
    return Layer.effect(HttpServer.HttpServer, Effect.interrupt)
  }
  const exit = await Effect.runPromiseExit(Layer.build(served(server)).pipe(Effect.scoped))
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  expect(addresses).toEqual([{ hostname: "127.0.0.1", port: 7331 }])
})
