/**
 * Real binary HTTP reads and Cache Storage capability injection. The native
 * browser cache is exercised by the app's offline reload E2E.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { BrowserCache } from "../src/index.ts"

let server: Server
let origin: string
let requests = 0
let slowStarted = false
let slowClosed = false
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
beforeAll(async () => {
  server = createServer((request, response) => {
    requests++
    if (request.url === "/slow") {
      slowStarted = true
      response.on("close", () => {
        slowClosed = true
      })
      return
    }
    response.writeHead(request.url === "/refused" ? 503 : 200).end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

const read = (layer: Layer.Layer<BrowserCache.AssetSource>, path = "/asset") =>
  Effect.runPromise(BrowserCache.readAsset(`${origin}${path}`).pipe(Effect.provide(layer)))

const source = (
  match: Effect.Effect<BrowserCache.AssetResponse | undefined, unknown>,
  fetch: Effect.Effect<BrowserCache.AssetResponse, unknown>
) => Layer.succeed(BrowserCache.AssetSource, { match: () => match, fetch: () => fetch })

describe("BrowserCache.readAsset", () => {
  it("reads the real network when no native cache exists", async () => {
    expect(new Uint8Array(await read(BrowserCache.layerAssets()))).toEqual(bytes)
  })

  it("reads a pre-cached response without touching the network", async () => {
    const counter = Metric.withAttributes(BrowserCache.assetReads, { source: "cache", outcome: "loaded" })
    const before = Effect.runSync(Metric.value(counter)).count
    const beforeRequests = requests
    const cached = new Response(bytes)
    const layer = BrowserCache.layerAssets({
      caches: { match: async () => cached },
      fetch: globalThis.fetch
    })
    expect(new Uint8Array(await read(layer))).toEqual(bytes)
    expect(Effect.runSync(Metric.value(counter)).count).toBe(before + 1)
    expect(requests).toBe(beforeRequests)
  })

  it("falls through a refused cache to the real network", async () => {
    const layer = BrowserCache.layerAssets({
      caches: {
        match: async () => {
          throw new Error("cache refused")
        }
      }
    })
    expect(new Uint8Array(await read(layer))).toEqual(bytes)
    const nonError = source(Effect.fail(0), Effect.succeed(new Response(bytes)))
    expect(new Uint8Array(await read(nonError))).toEqual(bytes)
  })

  it("does not serve an error response from the cache", async () => {
    const layer = BrowserCache.layerAssets({
      caches: { match: async () => new Response("old error", { status: 404 }) },
      fetch: globalThis.fetch
    })
    expect(new Uint8Array(await read(layer))).toEqual(bytes)
  })

  it("keeps real HTTP refusals typed without response content", async () => {
    await expect(read(BrowserCache.layerAssets(), "/refused")).rejects.toMatchObject({
      phase: "http",
      code: "HTTP_503"
    })
  })

  it("keeps a network failure typed", async () => {
    const effect = BrowserCache.readAsset("http://127.0.0.1:1/asset").pipe(Effect.provide(BrowserCache.layerAssets()))
    await expect(Effect.runPromise(effect)).rejects.toMatchObject({ phase: "network", code: "TypeError" })
    await expect(read(source(Effect.succeed(undefined), Effect.fail(0)))).rejects.toMatchObject({
      phase: "network",
      code: "unknown"
    })
  })

  it("refuses an already consumed cache body", async () => {
    const response = new Response(bytes)
    await response.arrayBuffer()
    await expect(read(source(Effect.succeed(response), Effect.fail(new Error("must not fetch"))))).rejects
      .toMatchObject({ phase: "body", code: "TypeError" })
  })
  it("cancels the real HTTP request and records cancellation", async () => {
    const counter = Metric.withAttributes(BrowserCache.assetReads, { source: "network", outcome: "cancelled" })
    const before = Effect.runSync(Metric.value(counter)).count
    const fiber = Effect.runFork(
      BrowserCache.readAsset(`${origin}/slow`).pipe(Effect.provide(BrowserCache.layerAssets()))
    )
    await vi.waitFor(() => expect(slowStarted).toBe(true))
    await Effect.runPromise(Fiber.interrupt(fiber))
    await vi.waitFor(() => expect(slowClosed).toBe(true))
    expect(Effect.runSync(Metric.value(counter)).count).toBe(before + 1)
  })
})
