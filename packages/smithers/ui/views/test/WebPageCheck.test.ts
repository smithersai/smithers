/**
 * `WebPage.check` against a real HTTP server on this machine, through
 * Effect's real `FetchHttpClient`: framing, previews, redirects, the guard
 * that refuses private hosts before anything is sent, deadlines and the body
 * cap. The server is on `127.0.0.1`, which the guard refuses unless a test
 * names it in `privateHosts`.
 */
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { WebPage } from "../src/index.ts"

const APP = "https://app.smithers.sh"

/** Every request the server saw, in order. */
const seen: Array<{ readonly path: string; readonly headers: IncomingHttpHeaders }> = []
/** Responses the server holds open, ended after each test. */
const open: Array<ServerResponse> = []

const page = (
  status: number,
  headers: Record<string, string>,
  body: string | Uint8Array,
  type = "text/html; charset=utf-8"
) =>
(response: ServerResponse) => {
  response.writeHead(status, { "content-type": type, ...headers })
  response.end(body)
}

const redirect = (location: string, status = 302) => (response: ServerResponse) => {
  response.writeHead(status, { location })
  response.end()
}

const HEAD = `<title>Frames welcome</title><meta name="description" content="A page that lets others frame it.">` +
  `<link rel="icon" href="https://127.0.0.1:1/icon.png">`

const routes: Record<string, (response: ServerResponse) => void> = {
  "/allows": page(200, {}, `<!doctype html><html><head>${HEAD}</head><body>Hello</body></html>`),
  "/unicode": page(
    200,
    {},
    `<head><title>İstanbul ${"🙂".repeat(200)}</title>` +
      `<meta name="description" content="🎉 ${"Big savings on everything this week. ".repeat(10)}">` +
      `<link rel="icon" href="https://127.0.0.1:1/i.png"></head>`
  ),
  "/deny": page(200, { "x-frame-options": "DENY" }, `<head><title>Refuses</title></head>`),
  "/csp": page(200, { "content-security-policy": "frame-ancestors 'self'" }, `<title>Self only</title>`),
  "/pdf": page(200, {}, "%PDF-1.7", "application/pdf"),
  "/missing": page(404, {}, `<title>Not found</title>`),
  "/image": page(200, {}, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"),
  "/r1": redirect("/r2", 301),
  "/r2": redirect("/allows", 307),
  "/loop": redirect("/loop"),
  "/to-private": redirect("http://10.0.0.1/"),
  "/to-script": redirect("javascript:alert(1)"),
  "/to-unparsable": redirect("http://[bad/"),
  "/no-location": (response) => {
    response.writeHead(302, { "content-type": "text/html" })
    response.end(`<title>Nowhere to go</title>`)
  },
  "/latin1": page(
    200,
    {},
    new Uint8Array([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0x43, 0x61, 0x66, 0xe9]),
    "text/html; charset=iso-8859-1"
  ),
  "/bogus-charset": page(200, {}, `<title>Café</title>`, "text/html; charset=bogus"),
  "/big": page(
    200,
    {},
    `<head><title>Early</title>${" ".repeat(10_000)}<meta name="description" content="Late"></head>`
  ),
  "/hang": (response) => void open.push(response),
  "/stall": (response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.write(`<head><title>Partial</title>`)
    open.push(response)
  },
  "/endless": (response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.write(`<head><title>Endless</title></head>`)
    open.push(response)
    const timer = setInterval(() => response.write("<p>more</p>".repeat(100)), 5)
    response.on("close", () => clearInterval(timer))
  },
  "/reset": (response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.write(`<head><title>Cut</title>`)
    setTimeout(() => response.socket?.destroy(), 20)
  }
}

let server: Server
let origin: string
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    seen.push({ path, headers: request.headers })
    const route = routes[path]
    if (route === undefined) {
      response.writeHead(404).end()
      return
    }
    route(response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  seen.length = 0
  for (const response of open.splice(0)) response.destroy()
})

const local = { ancestors: [APP], privateHosts: ["127.0.0.1"] }

/** `WebPage.check` of `url` through the real fetch, with `options` over `local`. */
const check = (url: string, options: Partial<WebPage.Options> = {}) =>
  Effect.runPromise(WebPage.check(url, { ...local, ...options }).pipe(Effect.provide(FetchHttpClient.layer)))

describe("WebPage.check: framing and previews", () => {
  it("returns unknown for a malformed ancestor after reading a real response", async () => {
    expect(await check(`${origin}/allows`, { ancestors: ["not a URL"] })).toMatchObject({
      framing: "unknown",
      reason: "invalid_url",
      status: 200,
      title: "Frames welcome"
    })
  })

  it("a page that allows framing is allowed, with its title, description and icon", async () => {
    expect(await check(`${origin}/allows`)).toEqual({
      framing: "allowed",
      status: 200,
      title: "Frames welcome",
      description: "A page that lets others frame it."
    })
  })

  it("returns a Unicode preview that survives the consumer's JSON schema decoder", async () => {
    const checked = await check(`${origin}/unicode`)
    expect(checked).toMatchObject({
      framing: "allowed",
      status: 200,
      title: `İstanbul ${"🙂".repeat(95)}…`,
      description: `🎉 ${"Big savings on everything this week. ".repeat(10).slice(0, 296).trimEnd()}…`
    })
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(WebPage.Checked))(JSON.stringify(checked))).toEqual(checked)
  })

  it("sends the request a frame sends: no cookies, a declared agent", async () => {
    await check(`${origin}/allows`)
    await check(`${origin}/allows`, { userAgent: "Agent/1" })
    expect(seen.map(({ headers }) => headers["user-agent"])).toEqual([
      "Mozilla/5.0 (compatible; web-page-check)",
      "Agent/1"
    ])
    // Node's fetch writes its own `sec-fetch-mode`; a Worker's sends the check's `navigate`.
    expect(seen[0]!.headers).toMatchObject({ "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" })
    expect(seen[0]!.headers.cookie).toBeUndefined()
    expect(seen[0]!.headers.authorization).toBeUndefined()
  })

  it("X-Frame-Options and frame-ancestors refuse, with the preview the card shows", async () => {
    expect(await check(`${origin}/deny`)).toEqual({
      framing: "refused",
      reason: "x_frame_options",
      status: 200,
      title: "Refuses"
    })
    expect(await check(`${origin}/csp`)).toMatchObject({
      framing: "refused",
      reason: "frame_ancestors",
      title: "Self only"
    })
  })

  it("a PDF is refused as content, with no preview; an image is allowed", async () => {
    expect(await check(`${origin}/pdf`)).toEqual({ framing: "refused", reason: "content", status: 200 })
    expect(await check(`${origin}/image`)).toEqual({ framing: "allowed", status: 200 })
  })

  it("an error status is unknown, with what its page says", async () => {
    expect(await check(`${origin}/missing`)).toEqual({
      framing: "unknown",
      reason: "status",
      status: 404,
      title: "Not found"
    })
  })

  it("decodes the charset the page declares, else UTF-8", async () => {
    expect((await check(`${origin}/latin1`)).title).toBe("Café")
    expect((await check(`${origin}/bogus-charset`)).title).toBe("Café")
  })
})

describe("WebPage.check: redirects", () => {
  it("follows redirects itself, guarding each, and judges the page it ends on", async () => {
    expect(await check(`${origin}/r1`)).toMatchObject({ framing: "allowed", status: 200, title: "Frames welcome" })
    expect(seen.map(({ path }) => path)).toEqual(["/r1", "/r2", "/allows"])
  })

  it("leaves a 3xx to the check even when the caller's fetch options say follow", async () => {
    const followed = await Effect.runPromise(
      WebPage.check(`${origin}/r1`, local).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "follow", headers: { "x-caller": "kept" } })
      )
    )
    expect(followed.framing).toBe("allowed")
    expect(seen.map(({ path, headers }) => [path, headers["x-caller"]])).toEqual([
      ["/r1", "kept"],
      ["/r2", "kept"],
      ["/allows", "kept"]
    ])
  })

  it("stops after maxRedirects", async () => {
    expect(await check(`${origin}/loop`, { maxRedirects: 2 })).toEqual({
      framing: "unknown",
      reason: "redirects",
      status: 302
    })
    expect(seen.map(({ path }) => path)).toEqual(["/loop", "/loop", "/loop"])
  })

  it("refuses a redirect to a private host or another scheme, and one it can't parse", async () => {
    expect(await check(`${origin}/to-private`)).toEqual({ framing: "unknown", reason: "private_host" })
    expect(await check(`${origin}/to-script`)).toEqual({ framing: "unknown", reason: "redirects" })
    expect(await check(`${origin}/to-unparsable`)).toEqual({ framing: "unknown", reason: "redirects", status: 302 })
    expect(seen.map(({ path }) => path)).toEqual(["/to-private", "/to-script", "/to-unparsable"])
  })

  it("a 3xx with nowhere to go is the page", async () => {
    expect(await check(`${origin}/no-location`)).toMatchObject({
      framing: "allowed",
      status: 302,
      title: "Nowhere to go"
    })
  })
})

describe("WebPage.check: the guard", () => {
  it("never requests a private, loopback, link-local or local host, however it is spelled", async () => {
    const port = new URL(origin).port
    const refused = [
      `${origin}/allows`,
      `http://2130706433:${port}/allows`,
      `http://0x7f.1:${port}/allows`,
      `http://[::1]:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      `http://localhost:${port}/`,
      `http://LOCALHOST.:${port}/`,
      `http://app.localhost:${port}/`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "https://8.8.8.8/",
      "http://intranet/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://router.home.arpa/",
      "http://nas.lan/"
    ]
    for (const url of refused) {
      expect([url, await check(url, { privateHosts: [] })]).toEqual([url, {
        framing: "unknown",
        reason: "private_host"
      }])
    }
    expect(seen).toEqual([])
  })

  it("refuses what isn't an http(s) URL without a user or password", async () => {
    for (
      const url of [
        "not a url",
        "javascript:alert(1)",
        "ftp://example.com/",
        "file:///etc/passwd",
        `http://user:pw@127.0.0.1/`
      ]
    ) {
      expect([url, await check(url)]).toEqual([url, { framing: "unknown", reason: "invalid_url" }])
    }
    expect(seen).toEqual([])
  })

  it("requests a public name, with no private hosts named", async () => {
    // The outside web stands in as a fetch that fails: the guard let the request go.
    const requested: Array<string> = []
    const offline: typeof globalThis.fetch = (input) => {
      requested.push(String(input))
      return Promise.reject(new TypeError("offline"))
    }
    const checked = await Effect.runPromise(
      WebPage.check("https://docs.example.com/guide", { ancestors: [APP] }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, offline)
      )
    )
    expect(checked).toEqual({ framing: "unknown", reason: "unreachable" })
    expect(requested).toEqual(["https://docs.example.com/guide"])
  })

  it("reads a private host only when privateHosts names it, in any case", async () => {
    expect(await check(`${origin}/allows`, { privateHosts: ["127.0.0.1"] })).toMatchObject({ framing: "allowed" })
    expect(await check(`http://LocalHost:${new URL(origin).port}/allows`, { privateHosts: ["LOCALHOST"] }))
      .toMatchObject({
        framing: "allowed"
      })
  })
})

describe("WebPage.check: deadlines and limits", () => {
  it("a page that never answers is a timeout", async () => {
    expect(await check(`${origin}/hang`, { timeout: "100 millis" })).toEqual({ framing: "unknown", reason: "timeout" })
  })

  it("a host that refuses the connection is unreachable", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(await check(`http://127.0.0.1:${port}/`)).toEqual({ framing: "unknown", reason: "unreachable" })
  })

  it("a head that stalls is read until headTimeout, and judged by its headers", async () => {
    const started = performance.now()
    expect(await check(`${origin}/stall`, { headTimeout: "150 millis" })).toEqual({
      framing: "allowed",
      status: 200,
      title: "Partial"
    })
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it("stops reading at </head>, however long the body runs", async () => {
    const started = performance.now()
    expect(await check(`${origin}/endless`, { headTimeout: "20 seconds" })).toMatchObject({ title: "Endless" })
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it("reads at most maxBytes", async () => {
    expect(await check(`${origin}/big`)).toMatchObject({ title: "Early", description: "Late" })
    expect(await check(`${origin}/big`, { maxBytes: 64 })).toEqual({
      framing: "allowed",
      status: 200,
      title: "Early"
    })
  })

  it("a body cut off keeps what arrived", async () => {
    expect(await check(`${origin}/reset`)).toEqual({ framing: "allowed", status: 200, title: "Cut" })
  })
})

describe("WebPage.check: records", () => {
  it("its span carries the framing, reason, status and redirects, never the URL", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const run = (url: string) =>
      Effect.runPromise(
        WebPage.check(url, local).pipe(
          Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(Tracer.Tracer, tracer)))
        )
      )
    await run(`${origin}/r1?sentinel-7c1d`)
    await run(`${origin}/deny`)
    await run("http://10.0.0.1/sentinel-7c1d")
    const checks = spans.filter((span) => span.name === "WebPage.check").map((span) =>
      Object.fromEntries(span.attributes)
    )
    expect(checks).toEqual([
      {
        "web_page.icon": "unavailable",
        "http.response.status_code": 200,
        "web_page.redirects": 2,
        "web_page.framing": "allowed"
      },
      {
        "http.response.status_code": 200,
        "web_page.redirects": 0,
        "web_page.icon": "absent",
        "web_page.framing": "refused",
        "web_page.reason": "x_frame_options"
      },
      { "web_page.framing": "unknown", "web_page.reason": "private_host" }
    ])
    expect(JSON.stringify(checks)).not.toContain("sentinel-7c1d")
    expect(JSON.stringify(checks)).not.toContain("127.0.0.1")
    // No client span records the URL, and the page gets no trace context.
    expect(spans.map((span) => span.name)).toEqual(["WebPage.check", "WebPage.check", "WebPage.check"])
    expect(seen.map(({ headers }) => [headers.traceparent, headers.b3])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined]
    ])
  })
})
