/**
 * A fetch a composition injects carries its own requests on every Node host
 * bundle.
 *
 * Effect's `FetchHttpClient` reads `FetchHttpClient.Fetch` from the fiber that
 * makes the request, and that fiber's context outranks the one the client was
 * built in (`HttpClient.layerMergedContext`). A flow runtime runs each step in a
 * fiber that carries its host's context, so a `Fetch` a host bundle provides
 * replaces the fetch every step's client was built with. On 2026-10-20 the
 * bundles provided `EgressHttpClient.providerFetch` that way, and apps/mvp's
 * tests, which inject the model through a fetch, sent their requests to the
 * network instead and hung until their timeout.
 *
 * Nothing leaves the loopback interface.
 */
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Context, Effect, Layer, Logger, References } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { HttpClient } from "effect/http/HttpClient"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, it } from "vitest"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import * as NodeHost from "../src/NodeHost.ts"

/** A loopback origin answering every request with "network", and its URL. */
const listen = async () => {
  const server: Server = createServer((_request, response) => response.end("network"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }
}

it("a step's injected fetch carries its requests, never a transport the host bundle chose", async () => {
  // A request that reaches this origin went around the injected fetch.
  const { server, url } = await listen()
  const injected: Array<string> = []
  const fetch = (async (input: RequestInfo | URL) => {
    injected.push(String(input))
    return new Response("injected")
  }) as typeof globalThis.fetch
  // A registration's client, built with the fetch its composition injects.
  const client = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const ledger = ProcessLedger.layerMemory({ hostId: "node-host-fetch", ownerPid: process.pid })
  const hosts = [
    NodeHost.layer,
    NodeHost.layerAt(process.cwd()),
    NodeHost.layerContained().pipe(Layer.provide(ledger)),
    NodeHost.layerContainedAt(process.cwd()).pipe(Layer.provide(ledger))
  ]
  try {
    for (const host of hosts) {
      const answered = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const hostContext = yield* Layer.build(host)
        const http = Context.get(yield* Layer.build(client), HttpClient)
        // The step's fiber runs in its host's context, as a flow runtime runs it.
        const response = yield* http.get(url).pipe(Effect.provide(hostContext))
        return yield* response.text
      })))
      expect(answered).toBe("injected")
    }
    expect(injected).toEqual([url, url, url, url])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("providerFetch names each request's origin in a debug log, never its path or query", async () => {
  const { server, url } = await listen()
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  try {
    const answered = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fetch = yield* EgressHttpClient.providerFetch({ HTTPS_PROXY: "", HTTP_PROXY: "", NO_PROXY: "" })
        return yield* Effect.promise(async () => (await fetch(`${url}v1/chat?key=fixture-secret`)).text())
      })).pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])
        ),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )
    expect(answered).toBe("network")
    expect(logs).toEqual([
      expect.objectContaining({
        level: "DEBUG",
        message: "platform-node.provider-fetch",
        annotations: { origin: url.slice(0, -1), protocol: "http/1.1" }
      })
    ])
    expect(JSON.stringify(logs)).not.toContain("fixture-secret")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.each(["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"])(
  "builds every host bundle and reaches loopback with an invalid %s",
  async (variable) => {
    const { server, url } = await listen()
    const keys = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"] as const
    const previous = keys.map((key) => [key, process.env[key]] as const)
    const ledger = ProcessLedger.layerMemory({ hostId: "invalid-proxy", ownerPid: process.pid })
    try {
      for (const key of keys) delete process.env[key]
      for (
        const value of [
          "proxy.internal:3128",
          "not a url",
          "http://[unterminated",
          "socks5://proxy.internal:1080",
          "http://%:password@proxy.internal:3128",
          "http://user:%@proxy.internal:3128",
          "http://%FF:password@proxy.internal:3128",
          "http://proxy.internal:3128/proxy",
          "http://proxy.internal:3128/?key=fixture-secret",
          "http://proxy.internal:3128/#fragment"
        ]
      ) {
        process.env[variable] = value
        const hosts = [
          NodeHost.layer,
          NodeHost.layerAt(process.cwd()),
          NodeHost.layerContained().pipe(Layer.provide(ledger)),
          NodeHost.layerContainedAt(process.cwd()).pipe(Layer.provide(ledger))
        ]
        for (const host of hosts) {
          const answered = await Effect.runPromise(
            Effect.gen(function*() {
              const client = yield* HttpClient
              const response = yield* client.get(url)
              return yield* response.text
            }).pipe(Effect.provide(host))
          )
          expect(answered).toBe("network")
        }
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
)

it("providerFetch builds with an invalid proxy, reaches loopback and rejects other origins without its value", async () => {
  const { server, url } = await listen()
  const value = "http://secret:password@[unterminated"
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const fetch = yield* EgressHttpClient.providerFetch({ HTTPS_PROXY: value })
      const response = yield* Effect.promise(() => fetch(url))
      expect(yield* Effect.promise(() => response.text())).toBe("network")
      const refused = yield* Effect.tryPromise(() => fetch("https://remote.invalid/blocked")).pipe(Effect.flip)
      expect(refused).toMatchObject({
        cause: { cause: { message: "Invalid HTTPS_PROXY: expected an HTTP or HTTPS proxy URL" } }
      })
      expect(String(refused)).not.toContain("password")
    })))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
