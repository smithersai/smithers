/** Fault injection at the Bun server boundary; the real runtime is covered by BunGateway.test. */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { beforeEach, expect, it, vi } from "vitest"
import * as BunGateway from "../src/bun/BunGateway.ts"
import { stack } from "./GatewayStack.ts"

vi.mock("@effect/platform-bun/BunHttpServer", () => ({ layerServer: vi.fn() }))

const server = vi.mocked(BunHttpServer.layerServer)
const health = { workspaceHash: "adapter-workspace", gatewayId: "adapter", protocolVersion: "1", version: "1" }
const served = (options?: BunGateway.ServerOptions) =>
  BunGateway.layer(health, options).pipe(Layer.provideMerge(stack()))
beforeEach(() => {
  server.mockReset()
})

it("serves the gateway through the supplied Bun address options", async () => {
  server.mockImplementation((options) => {
    if (options === undefined || !("hostname" in options) || !("port" in options)) {
      throw new Error("expected TCP options")
    }
    return NodeHttpServer.layerServer(createServer, { host: options.hostname, port: Number(options.port) })
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      const context = yield* Layer.build(served({ port: 0 }))
      const http = yield* HttpServer.HttpServer.pipe(Effect.provide(context))
      if (http.address._tag !== "InetAddressV4") throw new Error("expected a TCP address")
      const url = `http://127.0.0.1:${http.address.port}/health`
      const response = yield* Effect.promise(() => fetch(url))
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject(health)
      expect(server).toHaveBeenCalledWith({ hostname: "127.0.0.1", port: 0 })
    }).pipe(Effect.scoped)
  )
})

for (const code of ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"]) {
  it(`sanitizes Bun's ${code} bind defect`, async () => {
    server.mockReturnValue(Layer.effect(HttpServer.HttpServer, Effect.die({ code, message: "private socket details" })))
    const failure = await Effect.runPromise(
      Layer.build(served({ host: "localhost", port: 0 })).pipe(Effect.flip, Effect.scoped)
    )
    expect(failure).toMatchObject({ code: "bind_failed", message: "The gateway socket could not be bound" })
    expect(JSON.stringify(failure)).not.toContain("private socket details")
    expect(server).toHaveBeenCalledWith({ hostname: "localhost", port: 0 })
  })
}

for (const defect of ["unexpected defect", null, { message: "no code" }, { code: "UNKNOWN" }]) {
  it(`preserves an unexpected server defect: ${JSON.stringify(defect)}`, async () => {
    server.mockReturnValue(Layer.effect(HttpServer.HttpServer, Effect.die(defect)))
    const exit = await Effect.runPromiseExit(Layer.build(served({})).pipe(Effect.scoped))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
    expect(server).toHaveBeenCalledWith({ hostname: "127.0.0.1", port: 7331 })
  })
}

it("preserves interrupted startup with default options", async () => {
  server.mockReturnValue(Layer.effect(HttpServer.HttpServer, Effect.interrupt))
  const exit = await Effect.runPromiseExit(Layer.build(served()).pipe(Effect.scoped))
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  expect(server).toHaveBeenCalledWith({ hostname: "127.0.0.1", port: 7331 })
})
