/**
 * `EgressHttpClient.providerFetch`: the `fetch` a Node model host passes to
 * `HostModel`. It speaks HTTP/1.1 to an origin that offers HTTP/2, where
 * Undici's default pool negotiates HTTP/2: a provider's edge that tears an
 * HTTP/2 session down left every later call failing `ERR_HTTP2_INVALID_SESSION`
 * until the process restarted (api.cerebras.ai, Node 26.10, 2026-10-20).
 *
 * The origin is a loopback TLS server offering `h2` and `http/1.1` through
 * ALPN, with a certificate `openssl` makes for the run; without `openssl` the
 * cases skip and say so. Nothing leaves the loopback interface.
 */
import { Effect, Exit, Scope } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createSecureServer, type Http2SecureServer, type ServerHttp2Stream } from "node:http2"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"

/** A self-signed certificate for `localhost` and `127.0.0.1`, or the reason there is none. */
const certificate = (() => {
  const dir = mkdtempSync(join(tmpdir(), "provider-fetch-"))
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem")
    ], { stdio: "ignore" })
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }
  } catch {
    return undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** A TLS origin offering HTTP/2 and HTTP/1.1, answering each request with the protocol it arrived on. */
const listen = async (cert: { readonly key: Buffer; readonly cert: Buffer }, failures = 0) => {
  let requests = 0
  const server: Http2SecureServer = createSecureServer({ ...cert, allowHTTP1: true }, (request, response) => {
    if (++requests <= failures) {
      request.socket.destroy()
      return
    }
    response.writeHead(200, { "content-type": "text/plain" })
    response.end(request.httpVersion)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const direct = { HTTPS_PROXY: "", HTTP_PROXY: "", NO_PROXY: "" }

describe("EgressHttpClient.providerFetch (needs openssl)", () => {
  it("speaks HTTP/1.1 to an origin that offers HTTP/2, and answers its body", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const origin = yield* Effect.acquireRelease(
        Effect.promise(() => listen(certificate!)),
        (o) => Effect.promise(o.close)
      )
      const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
      const answers = yield* Effect.promise(() =>
        Promise.all([1, 2, 3].map(async () => {
          const response = await fetch(origin.url, { method: "POST", body: JSON.stringify({ n: 1 }) })
          return [response.status, await response.text()]
        }))
      )
      expect(answers).toEqual([[200, "1.1"], [200, "1.1"], [200, "1.1"]])
    }))))

  it("where the egress pool's default negotiates HTTP/2 with the same origin", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const origin = yield* Effect.acquireRelease(
        Effect.promise(() => listen(certificate!)),
        (o) => Effect.promise(o.close)
      )
      const pool = yield* EgressHttpClient.dispatcher(direct, { connect: { ca: certificate!.cert } })
      const undici = yield* Effect.promise(async () => (await import("undici")).default ?? (await import("undici")))
      const text = yield* Effect.promise(async () =>
        (await undici.fetch(origin.url, { dispatcher: pool as never })).text()
      )
      expect(text).toBe("2.0")
    }))))
  it.each([false, true])(
    "repairs a closed connection once before headers (byte body: %s)",
    (bytes) =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const legacy = yield* Effect.acquireRelease(
          Effect.promise(() => listen(certificate!, 1)),
          (o) => Effect.promise(o.close)
        )
        const oldPool = yield* EgressHttpClient.dispatcher(direct, {
          allowH2: false,
          connect: { ca: certificate!.cert }
        })
        const undici = yield* Effect.promise(async () => (await import("undici/index.js")).default)
        // The previous implementation delegated once, and lost this request.
        yield* Effect.promise(async () => {
          await expect(undici.fetch(legacy.url, { method: "POST", body: "replayable", dispatcher: oldPool as never }))
            .rejects.toMatchObject({ cause: { code: "UND_ERR_SOCKET" } })
        })
        expect(legacy.requests()).toBe(1)
        const origin = yield* Effect.acquireRelease(
          Effect.promise(() => listen(certificate!, 1)),
          (o) => Effect.promise(o.close)
        )
        const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
        const answer = yield* Effect.promise(async () =>
          (await fetch(origin.url, { method: "POST", body: bytes ? new Uint8Array([1, 2]) : "replayable" })).text()
        )
        expect(answer).toBe("1.1")
        expect(origin.requests()).toBe(2)
      })))
  )

  it("fails after the single repair instead of retrying a real outage", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const origin = yield* Effect.acquireRelease(
        Effect.promise(() => listen(certificate!, 10)),
        (o) => Effect.promise(o.close)
      )
      const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
      yield* Effect.promise(async () => {
        await expect(fetch(origin.url, { method: "POST", body: "replayable" })).rejects.toMatchObject({
          cause: { code: "UND_ERR_SOCKET" }
        })
      })
      expect(origin.requests()).toBe(2)
    }))))

  it("does not replay a Request", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const origin = yield* Effect.acquireRelease(Effect.promise(() => listen(certificate!, 10)), (o) =>
        Effect.promise(o.close))
      const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
      yield* Effect.promise(async () => {
        await expect(fetch(new Request(origin.url, { method: "POST", body: "request" }))).rejects.toBeDefined()
      })
      expect(origin.requests()).toBe(1)
    }))))

  it.each(["reset", "goaway"])("reproduces %s before headers on a local HTTP/2 origin", async (fault) => {
    const server = createSecureServer({ ...certificate!, allowHTTP1: true })
    let requests = 0
    server.on("sessionError", () => {})
    server.on("stream", (stream) => {
      stream.on("error", () => {})
      if (++requests === 1) {
        if (fault === "goaway") stream.session!.goaway(2, 0)
        stream.session!.destroy()
      } else {
        ;(stream as ServerHttp2Stream).respond({ ":status": 200 })
        stream.end("recovered")
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const pool = yield* EgressHttpClient.dispatcher(direct, { connect: { ca: certificate!.cert } })
        const undici = yield* Effect.promise(async () => (await import("undici/index.js")).default)
        yield* Effect.promise(async () => {
          await expect(undici.fetch(url, { dispatcher: pool as never })).rejects.toBeDefined()
          expect(await (await undici.fetch(url, { dispatcher: pool as never })).text()).toBe("recovered")
        })
      })))
      expect(requests).toBe(2)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("propagates an abort without a connection repair", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const origin = yield* Effect.acquireRelease(
        Effect.promise(() => listen(certificate!)),
        (o) => Effect.promise(o.close)
      )
      const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
      yield* Effect.promise(async () => {
        await expect(fetch(origin.url, { signal: AbortSignal.abort() })).rejects.toBeDefined()
      })
      expect(origin.requests()).toBe(0)
    })))
  })

  it("preserves a provider refusal without a transport retry", async () => {
    const server = createSecureServer({ ...certificate!, allowHTTP1: true }, (_request, response) => {
      response.writeHead(429)
      response.end("refused")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
        const response = yield* Effect.promise(() =>
          fetch(`https://127.0.0.1:${(server.address() as AddressInfo).port}`)
        )
        expect(response.status).toBe(429)
        expect(yield* Effect.promise(() => response.text())).toBe("refused")
      })))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("never replays a failure after response headers or a streaming upload", async () => {
    let requests = 0
    let breakBody: () => void = () => {}
    const server = createSecureServer({ ...certificate!, allowHTTP1: true }, (request, response) => {
      requests++
      if (request.url === "/upload") {
        request.socket.destroy()
        return
      }
      response.writeHead(200)
      response.write("partial")
      breakBody = () => response.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
        yield* Effect.promise(async () => {
          const response = await fetch(url)
          breakBody()
          await expect(response.text()).rejects.toBeDefined()
          const body = new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1]))
              c.close()
            }
          })
          await expect(fetch(`${url}/upload`, { method: "POST", body, duplex: "half" } as RequestInit)).rejects
            .toBeDefined()
        })
        expect(requests).toBe(2)
      })))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it("shares recovery across concurrent pre-header connection failures", async () => {
    let requests = 0
    const server = createSecureServer({ ...certificate!, allowHTTP1: true }, (request, response) => {
      const n = ++requests
      if (n <= 10) {
        setTimeout(() => request.socket.destroy(), n === 1 ? 0 : 20)
        return
      }
      response.end("recovered")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const fetch = yield* EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } })
        const responses = yield* Effect.promise(() =>
          Promise.all(Array.from({ length: 10 }, async () => (await fetch(url)).text()))
        )
        expect(responses).toEqual(Array(10).fill("recovered"))
        yield* Effect.promise(async () => {
          await expect(fetch("invalid-url")).rejects.toBeDefined()
          await expect(fetch(url, { method: "GET", body: "invalid" })).rejects.toBeDefined()
        })
      })))
      expect(requests).toBe(20)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("releases a retired pool with an unfinished body when the host closes", async () => {
    let failures = 0
    const server = createSecureServer({ ...certificate!, allowHTTP1: true }, (request, response) => {
      if (request.url === "/held") {
        response.writeHead(200)
        response.write("partial")
        return
      }
      if (++failures === 1) {
        request.socket.destroy()
        return
      }
      response.end("recovered")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    const scope = Effect.runSync(Scope.make())
    try {
      const fetch = await Effect.runPromise(
        Scope.provide(scope)(EgressHttpClient.providerFetch(direct, { connect: { ca: certificate!.cert } }))
      )
      const held = await fetch(`${url}/held`)
      expect(await (await fetch(url)).text()).toBe("recovered")
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await expect(held.text()).rejects.toBeDefined()
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it.each(["./fixtures/provider-fatal-tls.mjs", "./fixtures/%70rovider-fatal-tls.mjs"])(
    "repairs fatal TLS record corruption that permanently poisons Node's HTTP/2 session (%s)",
    (relative) => {
      // Both valid URL spellings name the real fixture; native Windows also
      // requires converting the URL's /D:/ prefix into a filesystem drive path.
      const fixture = new URL(relative, import.meta.url)
      const run = (mode: string) =>
        JSON.parse(execFileSync(process.execPath, [fileURLToPath(fixture), mode], {
          encoding: "utf8",
          timeout: 20_000
        })) as { undici: string; codes: string[] }
      const native = run("native")
      expect(native.codes[0]).toBe("ok")
      if (["8.7.0", "8.10.2"].includes(native.undici)) {
        expect(native.codes[1]).toBe("ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC")
        expect(native.codes.slice(2)).toEqual(Array(4).fill("ERR_HTTP2_INVALID_SESSION"))
      }
      expect(run("provider").codes).toEqual(Array(6).fill("ok"))
    }
  )
})
