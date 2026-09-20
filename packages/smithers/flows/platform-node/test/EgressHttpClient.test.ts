/**
 * The client a Node process should use reaches an origin the way its
 * environment says to, and the evidence is what the proxy was asked for.
 *
 * "The request failed" proves nothing here: a request that bypasses the proxy
 * and dies at a default-deny firewall fails too, and that is exactly the defect
 * this constructor exists to close (a judge inside a microsandbox dialling
 * `ai-gateway.vercel.sh` directly, every completion coming back unjudged). So
 * each case asserts what the proxy saw, and the unproxied case asserts the
 * origin itself was reached with the proxy left untouched.
 *
 * Nothing here leaves the loopback interface.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"

interface Listener {
  readonly url: string
  readonly host: string
  readonly port: number
  /** Every request line and tunnel this listener was asked for, in order. */
  readonly seen: ReadonlyArray<string>
  readonly close: () => Promise<void>
}

/** A loopback HTTP listener that records what it was asked for.
 *
 * It answers plain requests with `handle`, and records a `CONNECT` without
 * carrying it: an `https` origin behind an `http` proxy is a tunnel, so being
 * asked to open one is the whole evidence that the proxy was consulted.
 * `address` is the loopback name to bind, `127.0.0.1` unless a case needs the
 * IPv6 one. */
const listen = async (
  handle: (request: IncomingMessage, response: ServerResponse) => void = (_, response) => response.writeHead(204).end(),
  address: "127.0.0.1" | "::1" = "127.0.0.1"
): Promise<Listener> => {
  const seen: Array<string> = []
  const sockets = new Set<Duplex>()
  const server: Server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    handle(request, response)
  })
  server.on("connect", (request, socket) => {
    seen.push(`CONNECT ${request.url}`)
    socket.destroy()
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, address, resolve))
  const { port } = server.address() as AddressInfo
  const host = address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`
  return {
    url: `http://${host}`,
    host,
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

/** One request through the client the supplied environment selects. */
const reach = (environment: Readonly<Record<string, string | undefined>>, url: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(HttpClient.HttpClient, (client) => client.get(url))).pipe(
      Effect.provide(EgressHttpClient.layer(environment))
    )
  )

describe("the outbound client a Node process should use", () => {
  it("opens the tunnel through the proxy the lowercase variables name", async () => {
    const proxy = await listen()
    try {
      const answered = await reach(
        { http_proxy: proxy.url, https_proxy: proxy.url, no_proxy: "" },
        "https://origin.invalid/judge"
      )
      expect([...proxy.seen]).toEqual(["CONNECT origin.invalid:443"])
      // The tunnel is refused on purpose; reaching the proxy is the assertion.
      expect(answered._tag).toBe("Failure")
    } finally {
      await proxy.close()
    }
  })

  it("opens the tunnel through the proxy the uppercase variables name", async () => {
    const proxy = await listen()
    try {
      // What a microsandbox guest holds: HTTP_PROXY/HTTPS_PROXY/NO_PROXY only.
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "" },
        "https://origin.invalid/judge"
      )
      expect([...proxy.seen]).toEqual(["CONNECT origin.invalid:443"])
      expect(answered._tag).toBe("Failure")
    } finally {
      await proxy.close()
    }
  })

  it("carries an excluded origin itself when NO_PROXY names it", async () => {
    const proxy = await listen()
    const origin = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "127.0.0.1" },
        `${origin.url}/direct`
      )
      expect([...origin.seen]).toEqual(["GET /direct"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("carries loopback itself although the environment names a proxy and no exclusion", async () => {
    // Undici proxies every origin when NO_PROXY is empty, loopback included.
    // That is the configuration a corporate laptop or a local Charles/mitmproxy
    // leaves behind, and `smthrs --remote http://127.0.0.1:3000` has to reach
    // the server this machine is running, not the proxy on the way out of it.
    const proxy = await listen()
    const origin = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
        `${origin.url}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("carries `localhost` itself too, and still proxies the origin an exclusion does not name", async () => {
    const proxy = await listen()
    const origin = await listen()
    try {
      const local = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "origin.invalid" },
        `http://localhost:${origin.port}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(local._tag).toBe("Success")
      // The same agent still sends everything else out through the proxy: the
      // loopback exemption adds to the environment's exclusions, never replaces
      // them, and never turns the proxy off.
      const remote = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "origin.invalid" },
        "https://gateway.invalid/judge"
      )
      expect([...proxy.seen]).toEqual(["CONNECT gateway.invalid:443"])
      expect(remote._tag).toBe("Failure")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("carries `[::1]` itself, the third loopback name", async () => {
    const proxy = await listen()
    const origin = await listen(undefined, "::1")
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
        `${origin.url}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("exempts the three names only: another loopback address goes through the proxy", async () => {
    // The exemption is by name, the way Undici matches every NO_PROXY entry,
    // never by what the address is. `127.0.0.2` is loopback on the wire and
    // still an origin like any other here, so the proxy is asked to carry it.
    const proxy = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
        "http://127.0.0.2:1/rpc"
      )
      expect([...proxy.seen]).toEqual(["GET http://127.0.0.2:1/rpc"])
      expect(answered._tag).toBe("Success")
    } finally {
      await proxy.close()
    }
  })

  it("leaves a wildcard exclusion alone, which already names every origin", async () => {
    const proxy = await listen()
    const origin = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "*" },
        `${origin.url}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("is the plain Undici pool when the environment names no proxy", async () => {
    const origin = await listen()
    try {
      const answered = await reach({}, `${origin.url}/direct`)
      expect([...origin.seen]).toEqual(["GET /direct"])
      expect(answered._tag).toBe("Success")
      if (answered._tag !== "Success") throw new Error("expected the direct request to answer")
      expect(answered.success.status).toBe(204)
    } finally {
      await origin.close()
    }
  })
})
