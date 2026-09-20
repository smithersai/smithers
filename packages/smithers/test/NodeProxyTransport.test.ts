import { Effect } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createServer, request as httpRequest, type Server } from "node:http"
import { connect } from "node:net"
import type { Duplex } from "node:stream"
import { describe, expect, it } from "vitest"
import { environmentDispatcher, rebuildableTransport } from "../src/internal/NodeControlHost.ts"

const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

describe("Node model transport proxy policy", () => {
  it("carries loopback itself from the initial and rebuilt pools, and preserves a denied proxy failure", async () => {
    const tunnels: Array<string> = []
    const forwarded: Array<string | undefined> = []
    const sockets = new Set<Duplex>()
    const requests: Array<string | undefined> = []
    const target = createServer((request, response) => {
      requests.push(request.url)
      response.end("from the target")
    })
    const proxy = createServer((request, response) => {
      forwarded.push(request.url)
      const upstream = httpRequest(request.url!, { method: request.method, headers: request.headers }, (reply) => {
        response.writeHead(reply.statusCode!, reply.headers)
        reply.pipe(response)
      })
      upstream.on("error", () => response.writeHead(502).end())
      request.pipe(upstream)
    })
    proxy.on("connect", (request, downstream, head) => {
      tunnels.push(request.url!)
      if (request.url === "model.example.invalid:443") {
        downstream.end("HTTP/1.1 502 Test origin unavailable\r\nContent-Length: 0\r\n\r\n")
        return
      }
      const destination = new URL(`http://${request.url}`)
      const upstream = connect(Number(destination.port), destination.hostname, () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        upstream.write(head)
        downstream.pipe(upstream)
        upstream.pipe(downstream)
      })
      sockets.add(upstream)
      sockets.add(downstream)
      upstream.on("error", () => downstream.destroy())
      downstream.on("error", () => upstream.destroy())
    })
    const targetUrl = await listen(target)
    const proxyUrl = await listen(proxy)
    const exchange = (environment: Record<string, string>, rebuild = false) =>
      Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const transport = yield* rebuildableTransport(environmentDispatcher(environment))
          const first = yield* transport.client.execute(HttpClientRequest.get(`${targetUrl}/first`))
          expect(yield* first.text).toBe("from the target")
          if (rebuild) {
            const replacement = yield* transport.rebuild
            const second = yield* replacement.execute(HttpClientRequest.get(`${targetUrl}/rebuilt`))
            expect(yield* second.text).toBe("from the target")
          }
        })
      ))
    try {
      await exchange({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }, true)
      // The target is loopback, which `@smthrs/platform-node/EgressHttpClient`
      // always reaches directly however the environment names a proxy, and
      // which that module's own suite pins. What is this transport's alone is
      // the pool it hands out and the pool it builds to replace it: both
      // reached the target, so both are working clients of the same shape.
      expect(forwarded).toEqual([])
      await exchange({ http_proxy: proxyUrl, HTTP_PROXY: "http://127.0.0.1:1" })
      await exchange({ HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" })
      await exchange({ http_proxy: proxyUrl, no_proxy: "127.0.0.1", NO_PROXY: "invalid.example" })
      await exchange({})
      await exchange({ HTTPS_PROXY: proxyUrl })
      expect(forwarded).toEqual([])
      expect(requests).toEqual(["/first", "/rebuilt", "/first", "/first", "/first", "/first", "/first"])
      // A real HTTPS CONNECT reaches the configured proxy even when the
      // origin cannot resolve. Preserve the proxy's failure; never fall back
      // to direct egress after a denied request.
      const denied = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const transport = yield* rebuildableTransport(environmentDispatcher({ HTTPS_PROXY: proxyUrl }))
        return yield* Effect.exit(transport.client.execute(HttpClientRequest.get("https://model.example.invalid/")))
      })))
      expect(denied._tag).toBe("Failure")
      expect(tunnels).toEqual(["model.example.invalid:443"])
    } finally {
      for (const socket of sockets) socket.destroy()
      await Promise.all([target, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    }
  })
})
