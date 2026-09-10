import { afterEach, describe, expect, test, vi } from "vitest"
import {
  BROWSER_FETCH_MAX_BYTES,
  BROWSER_FETCH_MAX_TEXT,
  browserFetch,
  browserFetchResponseBody,
  extractReadableText,
  isPublicAddress,
  resolveHostOverHttps
} from "../src/BrowserFetch.ts"

/*
 * The browser tool's hard guards (§2d): https only, public hosts only AFTER
 * DNS resolution (and on every redirect hop), size cap, timeout, no
 * credentials. The resolver and the fetch are honest doubles here.
 */

describe("isPublicAddress", () => {
  test("private, loopback, link-local, and metadata addresses are refused", () => {
    for (
      const ip of [
        "127.0.0.1",
        "127.1.2.3",
        "10.0.0.8",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254", // the cloud metadata endpoint
        "169.254.0.1",
        "0.0.0.0",
        "100.64.0.1", // CGNAT
        "224.0.0.1", // multicast
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12::8",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1"
      ]
    ) {
      expect(isPublicAddress(ip)).toBe(false)
    }
  })

  test("public addresses pass", () => {
    for (
      const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "2606:4700::1111", "172.15.0.1", "172.32.0.1", "11.0.0.1"]
    ) {
      expect(isPublicAddress(ip)).toBe(true)
    }
  })
})

const okPage = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } })

describe("browserFetch guards", () => {
  const publicResolver = async () => ["140.82.112.3"]

  test("http is refused outright", async () => {
    const outcome = await browserFetch("http://example.com/", { resolveHost: publicResolver })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("https")
  })

  test("URL credentials never become an implicit Authorization header, including on redirects", async () => {
    let fetches = 0
    const deps = {
      resolveHost: publicResolver,
      fetchImpl: async () => {
        fetches += 1
        return new Response(null, { status: 302, headers: { location: "https://user:secret@example.com/" } })
      }
    }
    const direct = await browserFetch("https://user:secret@example.com/", deps)
    expect(direct.ok).toBe(false)
    expect(fetches).toBe(0)
    const redirect = await browserFetch("https://example.com/", deps)
    expect(redirect.ok).toBe(false)
    expect(fetches).toBe(1)
    if (!redirect.ok) expect(redirect.message).toContain("credentials")
  })

  test("internal hostnames are refused without resolving", async () => {
    for (const host of ["localhost", "db.internal", "nas.local", "home.lan"]) {
      let resolved = 0
      const outcome = await browserFetch(`https://${host}/`, {
        resolveHost: async () => {
          resolved += 1
          return ["140.82.112.3"]
        }
      })
      expect(outcome.ok).toBe(false)
      expect(resolved).toBe(0)
    }
  })

  test("a public hostname resolving to a private address is refused (the DNS check is after resolution)", async () => {
    const outcome = await browserFetch("https://sneaky.example.com/", {
      resolveHost: async () => ["169.254.169.254"]
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("private")
  })

  test("a private IP literal target is refused", async () => {
    const outcome = await browserFetch("https://127.0.0.1/admin", { resolveHost: publicResolver })
    expect(outcome.ok).toBe(false)
  })

  /*
   * A URL's hostname keeps IPv6 literals BRACKETED (`[::1]`), and the
   * WHATWG serializer writes IPv4-mapped addresses in hex (`[::ffff:7f00:1]`)
   * — both forms have to reach the guard already normalised, or the loopback
   * and unique-local space is reachable through the tool.
   */
  test("bracketed IPv6 literals are refused, in every notation, and never fetched", async () => {
    for (
      const target of [
        "https://[::1]/",
        "https://[fd00::1]/",
        "https://[fe80::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:7f00:1]/",
        "https://[::ffff:10.0.0.1]/",
        "https://[::]/"
      ]
    ) {
      let fetched = 0
      const outcome = await browserFetch(target, {
        resolveHost: publicResolver,
        fetchImpl: async () => {
          fetched += 1
          return okPage("<p>x</p>")
        }
      })
      expect({ target, ok: outcome.ok, fetched }).toEqual({ target, ok: false, fetched: 0 })
    }
  })

  test("a public IPv6 literal target is allowed", async () => {
    const outcome = await browserFetch("https://[2606:4700::1111]/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>ok</p>")
    })
    expect(outcome.ok).toBe(true)
  })

  test("a hostname resolving to a bracket-free private IPv6 address is refused", async () => {
    const outcome = await browserFetch("https://sneaky.example.com/", {
      resolveHost: async () => ["fd00::1"]
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("private")
  })

  test("a redirect into a private host is refused on the hop", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: async (hostname) => (hostname === "example.com" ? ["140.82.112.3"] : ["10.0.0.8"]),
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://internal.example.com/" } })
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("private")
  })

  test("an errored redirect body returns an honest failure when there is nowhere to go", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body disconnected"))
            }
          }),
          { status: 302 }
        )
    })
    expect(outcome).toEqual({ ok: false, message: "The page answered HTTP 302 with nowhere to go." })
  })

  test.each(["pending", "rejecting"])("a %s redirect cancellation does not block the next hop", async (cleanup) => {
    let fetches = 0
    let cancelled = false
    const outcome = await browserFetch("https://example.com/", {
      timeoutMs: 20,
      resolveHost: publicResolver,
      fetchImpl: async () => {
        fetches += 1
        return fetches === 1
          ? new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
                return cleanup === "pending" ? new Promise(() => {}) : Promise.reject(new Error("cleanup failed"))
              }
            }),
            { status: 302, headers: { location: "https://next.example.com/" } }
          )
          : okPage("<p>ok</p>")
      }
    })
    expect(outcome).toMatchObject({ ok: true, finalUrl: "https://next.example.com/", text: "ok" })
    expect(fetches).toBe(2)
    expect(cancelled).toBe(true)
  }, 1000)

  test("pins each request to the address approved for that redirect hop", async () => {
    const connected: Array<string> = []
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: async (hostname) => hostname === "example.com" ? ["203.0.113.10"] : ["203.0.113.11"],
      fetchImpl: async (_url, _init, address) => {
        connected.push(address)
        return connected.length === 1
          ? new Response(null, { status: 302, headers: { location: "https://next.example.com/" } })
          : okPage("<p>ok</p>")
      }
    })
    expect(outcome.ok).toBe(true)
    expect(connected).toEqual(["203.0.113.10", "203.0.113.11"])
  })

  test("fails closed instead of falling back to a second hostname lookup", async () => {
    const outcome = await browserFetch("https://example.com/", { resolveHost: publicResolver })
    expect(outcome).toEqual({ ok: false, message: "Secure pinned egress is unavailable for the browser tool." })
  })

  test("a readable page returns text, the final URL, the status — and frameability", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        okPage(
          "<html><head><style>body{color:red}</style></head><body><h1>Hello</h1><script>evil()</script> there</body></html>"
        )
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.status).toBe(200)
      expect(outcome.finalUrl).toBe("https://example.com/")
      expect(outcome.text).toBe("Hello there")
      expect(outcome.frameable).toBe(true)
    }
  })

  test("X-Frame-Options and CSP frame-ancestors mark the page unframeable, honestly", async () => {
    const xfo = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>x</p>", { "x-frame-options": "DENY" })
    })
    expect(xfo.ok).toBe(true)
    if (xfo.ok) {
      expect(xfo.frameable).toBe(false)
      expect(xfo.blockReason).toContain("X-Frame-Options")
    }
    const csp = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        okPage("<p>x</p>", { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" })
    })
    expect(csp.ok).toBe(true)
    if (csp.ok) expect(csp.frameable).toBe(false)
    // frame-ancestors is an ALLOWLIST: a list of named origins does not
    // include this app, so the card must say so rather than frame a blank.
    const named = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        okPage("<p>x</p>", { "content-security-policy": "frame-ancestors https://partner.example.com" })
    })
    expect(named.ok).toBe(true)
    if (named.ok) {
      expect(named.frameable).toBe(false)
      expect(named.blockReason).toContain("frame-ancestors")
    }
    // A directive that admits any origin still frames.
    const wildcard = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>x</p>", { "content-security-policy": "frame-ancestors *" })
    })
    expect(wildcard.ok).toBe(true)
    if (wildcard.ok) expect(wildcard.frameable).toBe(true)
  })

  test("X-Frame-Options SAMEORIGIN refuses embedding", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>x</p>", { "x-frame-options": "SAMEORIGIN" })
    })
    expect(outcome).toMatchObject({
      ok: true,
      frameable: false,
      blockReason: "The site refuses embedding (X-Frame-Options: SAMEORIGIN)."
    })
  })

  test.each(["*:*", "https:", "http:", "https://*", "'self' https:"])(
    "a frame-ancestors list containing %s admits any origin and still frames",
    async (token) => {
      const outcome = await browserFetch("https://example.com/", {
        resolveHost: publicResolver,
        fetchImpl: async () => okPage("<p>x</p>", { "content-security-policy": `frame-ancestors ${token}` })
      })
      expect(outcome).toMatchObject({ ok: true, frameable: true, blockReason: null })
    }
  )

  /*
   * Every enforced policy applies on its own. A permissive first policy
   * cannot override a later `frame-ancestors 'none'`, whether the policies
   * arrive as repeated headers (which Headers.get joins with a comma) or as
   * one comma-combined header, and in either order.
   */
  test.each([
    ["repeated headers, permissive first", ["frame-ancestors *;", "frame-ancestors 'none';"]],
    ["repeated headers, restrictive first", ["frame-ancestors 'none';", "frame-ancestors *;"]],
    ["comma-combined, permissive first", ["default-src 'self'; frame-ancestors *, frame-ancestors 'none'"]],
    ["comma-combined, restrictive first", ["frame-ancestors 'none', frame-ancestors *; img-src *"]]
  ])("%s: any refusing CSP policy makes the page unframeable", async (_label, policies) => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => {
        const headers = new Headers({ "content-type": "text/html" })
        for (const policy of policies) headers.append("content-security-policy", policy)
        return new Response("<p>x</p>", { status: 200, headers })
      }
    })
    expect(outcome).toMatchObject({
      ok: true,
      frameable: false,
      blockReason: "The site refuses embedding (Content-Security-Policy frame-ancestors 'none')."
    })
  })

  test("several policies that all admit any origin still frame", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        okPage("<p>x</p>", {
          "content-security-policy": "frame-ancestors *, default-src 'self'; frame-ancestors https:"
        })
    })
    expect(outcome).toMatchObject({ ok: true, frameable: true, blockReason: null })
  })

  test("a bare frame-ancestors directive with no sources refuses embedding", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>x</p>", { "content-security-policy": "frame-ancestors" })
    })
    expect(outcome).toMatchObject({ ok: true, frameable: false })
  })

  test("the request carries no credentials and the declared user-agent", async () => {
    let seen: RequestInit | undefined
    await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async (_input, init) => {
        seen = init
        return okPage("<p>x</p>")
      }
    })
    const headers = new Headers(seen?.headers)
    expect(headers.get("user-agent")).toBe("smithers-browser")
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("authorization")).toBeNull()
  })

  /*
   * The byte cap is what keeps the Worker from buffering an unbounded body.
   * The text cap (BROWSER_FETCH_MAX_TEXT) would truncate the OUTPUT on its
   * own, so the assertion has to watch the bytes actually pulled from the
   * body and the cancellation that stops the read.
   */
  test("the size cap stops reading the body at BROWSER_FETCH_MAX_BYTES and cancels the stream", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024))
    const total = 4 * 1024 * 1024
    let pulled = 0
    let cancelReason: unknown
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= total) {
                controller.close()
                return
              }
              pulled += chunk.byteLength
              controller.enqueue(chunk)
            },
            cancel(reason) {
              cancelReason = reason
            }
          }),
          { status: 200, headers: { "content-type": "text/plain" } }
        )
    })
    expect(outcome).toMatchObject({ ok: true, text: "x".repeat(BROWSER_FETCH_MAX_TEXT) })
    expect(cancelReason).toBe("size cap")
    expect(pulled).toBeGreaterThanOrEqual(BROWSER_FETCH_MAX_BYTES)
    expect(pulled).toBeLessThan(total)
  })

  test.each(["pending", "rejecting"])("a %s size-cap cancellation does not block the result", async (cleanup) => {
    let cancelReason: unknown
    const outcome = await browserFetch("https://example.com/", {
      timeoutMs: 20,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(BROWSER_FETCH_MAX_BYTES + 1)))
            },
            cancel(reason) {
              cancelReason = reason
              return cleanup === "pending" ? new Promise(() => {}) : Promise.reject(new Error("cleanup failed"))
            }
          })
        )
    })
    expect(outcome).toMatchObject({ ok: true, text: "x".repeat(BROWSER_FETCH_MAX_TEXT) })
    expect(cancelReason).toBe("size cap")
  }, 1000)

  test("a redirect chain past MAX_REDIRECTS stops after four fetches", async () => {
    let fetches = 0
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => {
        fetches += 1
        return new Response(null, { status: 302, headers: { location: `https://example.com/${fetches}` } })
      }
    })
    expect(outcome).toEqual({ ok: false, message: "The page redirected too many times." })
    expect(fetches).toBe(4)
  })

  test("a 3xx without a Location header is an honest failure", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(null, { status: 301 })
    })
    expect(outcome).toEqual({ ok: false, message: "The page answered HTTP 301 with nowhere to go." })
  })

  test("a bodiless 204 succeeds with empty text and its frameability", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(null, { status: 204, headers: { "x-frame-options": "DENY" } })
    })
    expect(outcome).toEqual({
      ok: true,
      status: 204,
      finalUrl: "https://example.com/",
      contentType: "",
      text: "",
      frameable: false,
      blockReason: "The site refuses embedding (X-Frame-Options: DENY)."
    })
  })

  test("a non-HTML body is returned raw, not run through extraction", async () => {
    const body = "line one\n<not a tag> &amp; still raw   spaced"
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } })
    })
    expect(outcome).toMatchObject({ ok: true, contentType: "text/plain", text: body })
  })

  test("browserFetchResponseBody maps both outcomes to the route's JSON shape", () => {
    expect(browserFetchResponseBody({ ok: false, message: "m" })).toEqual({ status: "error", message: "m" })
    expect(
      browserFetchResponseBody({
        ok: true,
        status: 200,
        finalUrl: "https://example.com/",
        contentType: "text/html",
        text: "t",
        frameable: false,
        blockReason: "r"
      })
    ).toEqual({
      status: 200,
      finalUrl: "https://example.com/",
      contentType: "text/html",
      text: "t",
      frameable: false,
      blockReason: "r"
    })
  })

  test("an empty DNS answer is 'could not be resolved', a resolver fault says to try again", async () => {
    const empty = await browserFetch("https://example.com/", {
      resolveHost: async () => [],
      fetchImpl: async () => okPage("unexpected")
    })
    expect(empty).toEqual({ ok: false, message: "The host example.com could not be resolved." })
    const outage = await browserFetch("https://example.com/", {
      resolveHost: async () => {
        throw new Error("status 503")
      },
      fetchImpl: async () => okPage("unexpected")
    })
    expect(outage).toEqual({ ok: false, message: "The name resolver did not answer (status 503); try again." })
  })

  test("an unreachable host is an honest failure, never a throw", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => {
        throw new Error("connection refused")
      }
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok === false) expect(outcome.message).toContain("connection refused")
  })

  test("the total deadline bounds a resolver that never returns", async () => {
    let fetched = false
    const outcome = await browserFetch("https://example.com", {
      timeoutMs: 20,
      resolveHost: () => new Promise(() => {}),
      fetchImpl: async () => {
        fetched = true
        return okPage("unexpected")
      }
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("took too long")
    expect(fetched).toBe(false)
  })

  test("the total deadline bounds a fetchImpl that never returns headers", async () => {
    let fetched = false
    const outcome = await browserFetch("https://example.com/", {
      timeoutMs: 20,
      resolveHost: publicResolver,
      fetchImpl: () => {
        fetched = true
        return new Promise(() => {})
      }
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("took too long")
    expect(fetched).toBe(true)
  }, 1000)

  test("the total deadline still fires on a redirect hop while cleanup is pending", async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const outcome = await browserFetch("https://example.com/", {
      timeoutMs: 20,
      resolveHost: publicResolver,
      fetchImpl: async (_input, init) => {
        signals.push(init.signal)
        if (signals.length > 1) return new Promise(() => {})
        return new Response(
          new ReadableStream({
            cancel() {
              return new Promise(() => {})
            }
          }),
          { status: 302, headers: { location: "https://next.example.com/" } }
        )
      }
    })
    expect(outcome).toEqual({ ok: false, message: "Reading next.example.com took too long and was stopped." })
    expect(signals).toHaveLength(2)
    expect(signals[1]).toBe(signals[0])
    expect(signals[1]?.aborted).toBe(true)
  }, 1000)

  test("a stalled body times out and cancels its stream after headers arrive", async () => {
    let cancelled = false
    const outcome = await browserFetch("https://example.com", {
      timeoutMs: 20,
      resolveHost: publicResolver,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"))
            },
            cancel() {
              cancelled = true
            }
          })
        )
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("took too long")
    expect(cancelled).toBe(true)
  })

  test("a body error is returned as a failure instead of rejecting the route", async () => {
    const outcome = await browserFetch("https://example.com", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body disconnected"))
            }
          })
        )
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("body disconnected")
  })
})

describe("resolveHostOverHttps", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const dnsJson = (answers: Array<{ type: number; data: string }>) =>
    new Response(JSON.stringify({ Answer: answers }), {
      status: 200,
      headers: { "content-type": "application/dns-json" }
    })

  test("collects A and AAAA answers", async () => {
    vi.stubGlobal("fetch", async (input: string) =>
      input.includes("type=A&") || input.endsWith("type=A")
        ? dnsJson([{ type: 1, data: "140.82.112.3" }, { type: 5, data: "alias.example.com." }])
        : dnsJson([{ type: 28, data: "2606:4700::1111" }]))
    await expect(resolveHostOverHttps("example.com")).resolves.toEqual(["140.82.112.3", "2606:4700::1111"])
  })

  test("a non-2xx resolver answer is a fault carrying the status, not an empty answer set", async () => {
    let cancelled = 0
    vi.stubGlobal("fetch", async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled += 1
          }
        }),
        { status: 503 }
      ))
    await expect(resolveHostOverHttps("example.com")).rejects.toThrow("status 503")
    expect(cancelled).toBeGreaterThan(0)
  })
})

describe("extractReadableText", () => {
  test.each(["<", "<script ", "<style ", "<noscript ", "<!-- "])(
    "extracts repeated unclosed %s within 100 ms",
    (opener) => {
      // Catch the quadratic regression on a smaller input before trying the full body cap.
      for (const count of [opener === "<" ? 40_000 : 10_000, opener === "<" ? BROWSER_FETCH_MAX_BYTES : 60_000]) {
        const html = opener.repeat(count)
        const started = performance.now()
        extractReadableText(html)
        expect(performance.now() - started).toBeLessThan(100)
      }
    }
  )

  test("preserves normal page text, mixed-case blocks, entities, and Unicode", () => {
    const html = `<!doctype html><html><head><title>İ News</title>
      <STYLE media="screen">body { color: red; }</STYLE ></head>
      <body><h1>Hi &amp; bye</h1><!-- hidden <p>comment</p> -->
      <ScRiPt type="text/javascript">if (a < b) run()</sCrIpT >
      <noscript>hidden fallback</noscript><p>&nbsp;&lt;tag&gt; &quot;yes&quot; &#39;ok&apos;</p>
      <scripture>visible</scripture></body></html>`
    expect(extractReadableText(html)).toBe("İ News Hi & bye <tag> \"yes\" 'ok' visible")
    expect(extractReadableText(`<p>${"x".repeat(BROWSER_FETCH_MAX_BYTES)}</p>`)).toBe(
      "x".repeat(BROWSER_FETCH_MAX_TEXT)
    )
  })

  test.each(["<script>", "<style>", "<noscript>", "<!--", "<div"])(
    "drops the rest of an unclosed %s",
    (opener) => {
      expect(extractReadableText(`before ${opener} hidden`)).toBe("before")
    }
  )

  test("ignores closing block name prefixes until a complete closing tag", () => {
    expect(extractReadableText("before<script>hidden</scripture>still hidden</script >after")).toBe("before after")
  })

  test("strips scripts, styles, and tags; decodes entities; collapses whitespace", () => {
    expect(extractReadableText("<style>a{}</style><script>b()</script><h1>Hi &amp; bye</h1>  <p>there</p>")).toBe(
      "Hi & bye there"
    )
  })
})
