import { describe, expect, spyOn, test } from "bun:test"
import { AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { COMING_SOON_WORKER_FIRST } from "./appDocument"
import worker, { PLATFORM_PROXY_RULES, TurnCancelRegistry } from "./index"
import type { TurnCancelNamespace, TurnCancelStorage, WorkerEnv } from "./index"
import type { TurnLimitNamespace } from "./turnLimit"

const assetsEnv = (html = "<html><body>smithers</body></html>"): WorkerEnv => ({
  ASSETS: { fetch: async () => new Response(html, { status: 200 }) }
})

const turnBody = {
  runId: "run-1",
  messages: [{ role: "user", content: "Hello who are you" }],
  instructions: "Be brief."
}

const ndjsonUpstream = (lines: ReadonlyArray<unknown>): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  )

const post = (path: string, body: unknown): Request =>
  new Request(`https://mvp.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

/*
 * The app under the apex: smithers.sh/<owner>/<name>. wrangler.jsonc routes
 * `smithers.sh/smithersai/*` and `/w/*` here and runs the Worker first for
 * them, so this handler, not the assets layer, decides what a repository path
 * or a frame path answers. The assets are the smithers.sh Astro build: the
 * app document is prerendered at /<owner>/<name>/index.html beside the landing
 * page, the docs, and a 404 page.
 */
describe("routed repository pages", () => {
  const APP_DOCUMENT = "<html><head><meta name=\"smithers-build-sha\" content=\"abc\"></head><body>smithers app</body></html>"
  const COMING_SOON_PAGE = "<html><body>incur, coming soon</body></html>"
  const siteEnv = () => {
    const served: Array<string> = []
    const env: WorkerEnv = {
      ASSETS: {
        fetch: async (request) => {
          const path = new URL(request.url).pathname
          served.push(path)
          const html = { "content-type": "text/html; charset=utf-8" }
          if (path === "/smithersai/smithers/") return new Response(APP_DOCUMENT, { status: 200, headers: html })
          if (path === "/wevm/incur/") return new Response(COMING_SOON_PAGE, { status: 200, headers: html })
          if (path === "/" || path === "/docs/") return new Response("<html><body>site</body></html>", { status: 200, headers: html })
          if (path === "/_astro/a.js") {
            return new Response("export {}", { status: 200, headers: { "content-type": "text/javascript" } })
          }
          return new Response("<html><body>404 page</body></html>", { status: 404, headers: html })
        }
      }
    }
    return { env, served }
  }
  const isolation = (response: Response) => ({
    coop: response.headers.get("Cross-Origin-Opener-Policy"),
    coep: response.headers.get("Cross-Origin-Embedder-Policy")
  })

  test("a catalog repository serves the prerendered app document by its canonical path, whatever the case or trailing slash", async () => {
    for (const path of ["/smithersai/smithers", "/SmithersAI/Smithers", "/smithersai/smithers/"]) {
      const { env, served } = siteEnv()
      const response = await worker.fetch(new Request(`https://smithers.sh${path}`), env)
      expect({ path, status: response.status, served }).toEqual({ path, status: 200, served: ["/smithersai/smithers/"] })
      expect(isolation(response)).toEqual({ coop: "same-origin", coep: "require-corp" })
      expect(await response.text()).toBe(APP_DOCUMENT)
    }
  })

  test("a frame path inside the app serves the app document with the isolation headers", async () => {
    for (const path of ["/w/ws-1/b/main/f/frame-1", "/w/ws-1/b/main/f/frame-1/", "/w/a%20b/b/c/f/d"]) {
      const { env, served } = siteEnv()
      const response = await worker.fetch(new Request(`https://smithers.sh${path}`), env)
      expect({ path, status: response.status, served }).toEqual({ path, status: 200, served: ["/smithersai/smithers/"] })
      expect(isolation(response)).toEqual({ coop: "same-origin", coep: "require-corp" })
    }
  })

  test("a path under /w/ that is not a frame path stays with the assets layer", async () => {
    for (const path of ["/w/ws-1", "/w/ws-1/b/main", "/w/ws-1/b/main/f/frame-1/extra", "/w/"]) {
      const { env, served } = siteEnv()
      const response = await worker.fetch(new Request(`https://smithers.sh${path}`), env)
      expect({ path, status: response.status, served }).toEqual({ path, status: 404, served: [path] })
      expect(isolation(response)).toEqual({ coop: null, coep: null })
    }
  })

  test("any other path under the routed owner redirects to the site without touching the assets", async () => {
    for (const path of ["/smithersai/unknown", "/smithersai/smithers/issues/3", "/smithersai/"]) {
      const { env, served } = siteEnv()
      const response = await worker.fetch(new Request(`https://smithers.sh${path}`), env)
      expect({ path, status: response.status, location: response.headers.get("location"), served }).toEqual({
        path, status: 302, location: "https://smithers.sh/", served: []
      })
    }
  })

  test("a coming-soon repository serves its prerendered site page by canonical path, whatever the case of the repository or trailing slash, without the app's isolation headers", async () => {
    // wrangler runs the Worker first for the owner (the test on run_worker_first
    // below), so the Worker sees the canonical path and the variants the assets
    // have no file for, and must not leave the variants to the 404 page.
    for (const path of ["/wevm/incur", "/WEVM/Incur", "/wevm/incur/"]) {
      const { env, served } = siteEnv()
      const response = await worker.fetch(new Request(`https://smithers.sh${path}`), env)
      expect({ path, status: response.status, served }).toEqual({ path, status: 200, served: ["/wevm/incur/"] })
      expect(isolation(response)).toEqual({ coop: null, coep: null })
      expect(await response.text()).toBe(COMING_SOON_PAGE)
    }
  })

  test("a path beside a coming-soon repository stays with the assets layer", async () => {
    for (const path of ["/wevm/incur/issues/3", "/wevm/other", "/wevm/"]) {
      const { env, served } = siteEnv()
      const response = await worker.fetch(new Request(`https://smithers.sh${path}`), env)
      expect({ path, status: response.status, served }).toEqual({ path, status: 404, served: [path] })
    }
  })

  test("the site's pages and chunks pass through as the assets layer serves them; the Worker adds no isolation headers", async () => {
    // The docs load Google Fonts and Pagefind, which COEP require-corp would
    // block. The /_astro chunks do carry COEP and CORP live, from the build's
    // own apps/site/public/_headers (the OPFS module worker script needs its
    // owner document's embedder policy), which this fake assets layer does not
    // model: the claim here is only that the Worker adds nothing of its own.
    for (const [path, status] of [["/", 200], ["/docs/", 200], ["/_astro/a.js", 200], ["/nope", 404]] as const) {
      const { env, served } = siteEnv()
      const response = await worker.fetch(new Request(`https://smithers.sh${path}`), env)
      expect({ path, status: response.status, served }).toEqual({ path, status, served: [path] })
      expect(isolation(response)).toEqual({ coop: null, coep: null })
      expect(response.headers.get("X-Robots-Tag")).toBeNull()
    }
  })

  test("the canary hostname marks every HTML response noindex and leaves other assets alone", async () => {
    for (const path of ["/smithersai/smithers", "/w/ws-1/b/main/f/frame-1", "/", "/docs/", "/nope"]) {
      const { env } = siteEnv()
      const response = await worker.fetch(new Request(`https://canary.smithers.sh${path}`), env)
      expect({ path, robots: response.headers.get("X-Robots-Tag") }).toEqual({ path, robots: "noindex" })
    }
    const { env } = siteEnv()
    const chunk = await worker.fetch(new Request("https://canary.smithers.sh/_astro/a.js"), env)
    expect(chunk.headers.get("X-Robots-Tag")).toBeNull()
    const apex = await worker.fetch(new Request("https://smithers.sh/smithersai/smithers"), env)
    expect(apex.headers.get("X-Robots-Tag")).toBeNull()
  })

  test("wrangler runs the Worker first for every routed owner, every coming-soon owner in its GitHub case and in lowercase, and the frame prefix, and routes the whole apex beside the canary", async () => {
    // Without the run_worker_first entries the assets layer answers /smithersai/*
    // and /w/* before this Worker sees them, and the handlers above are dead on
    // Cloudflare. The coming-soon branch is dead the same way: wrangler matches
    // the patterns case-sensitively and a navigation to a path the build has no
    // file for is the 404 page before the Worker runs, so a lowercase
    // /effect-ts/effect is the 404 page unless its owner is listed both ways.
    const wrangler = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()
    const config = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, "")) as {
      routes: Array<{ pattern: string; custom_domain?: boolean; zone_id?: string }>
      assets: { run_worker_first: Array<string> }
    }
    expect(config.assets.run_worker_first).toContain("/smithersai/*")
    expect(config.assets.run_worker_first).toContain("/w/*")
    expect(COMING_SOON_WORKER_FIRST).toContain("/Effect-TS/*")
    expect(COMING_SOON_WORKER_FIRST).toContain("/effect-ts/*")
    expect(COMING_SOON_WORKER_FIRST).toContain("/wevm/*")
    for (const entry of COMING_SOON_WORKER_FIRST) expect(config.assets.run_worker_first).toContain(entry)
    // One apex route: the page HTML and its /_astro chunks come from the same
    // build. Splitting the apex by prefix once served the chunks from the old
    // assets-only Worker (404), see DEPLOY.md "Cutover log".
    expect(config.routes).toEqual([
      { pattern: "canary.smithers.sh", custom_domain: true },
      { pattern: "smithers.sh/*", zone_id: "8ebd98d2f0dc7d8db2e61f31ebc19c14" }
    ])
  })
})

describe("smithers mvp worker", () => {
  test("serves the site's root as the assets layer answers it, without the app's isolation headers", async () => {
    const response = await worker.fetch(new Request("https://mvp.test/"), assetsEnv())
    expect(response.status).toBe(200)
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBeNull()
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBeNull()
    expect(await response.text()).toContain("smithers")
  })

  test("describes the cloud runtime before the SPA selects adapters", async () => {
    const response = await worker.fetch(
      new Request("https://mvp.test/api/bootstrap"),
      {
        ...assetsEnv(),
        SMITHERS_BUILD_SHA: "build-abc",
        SMITHERS_CHAT_AUTH_TOKEN: "chat-token",
        IDENTITY_UPSTREAM_URL: "https://identity.test",
        SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test",
        BILLING_CHECKOUT_ENABLED: "1"
      }
    )

    expect(response.status).toBe(200)
    expect(AppBootstrapSchema.parse(await response.json())).toEqual({
      apiVersion: 1,
      host: "cloud",
      version: "1.0.0",
      buildSha: "build-abc",
      capabilities: ["agent", "identity", "cloud", "billing.checkout"],
      authFlow: "redirect",
      sandbox: null
    })
  })

  test("rejects a turn body over the 1 MB cap with 413", async () => {
    const response = await worker.fetch(
      post("/api/agent/turn", { ...turnBody, instructions: "x".repeat(1100 * 1024) }),
      assetsEnv()
    )
    expect(response.status).toBe(413)
  })

  test("stops reading a chunked turn body as soon as it crosses the cap", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700 * 1024))
        controller.enqueue(new Uint8Array(700 * 1024))
      },
      cancel() {
        cancelled = true
      }
    })
    const response = await worker.fetch(
      new Request("https://mvp.test/api/agent/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      }),
      assetsEnv()
    )
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
  })

  /**
   * The cap is a byte cap: a body of multi-byte characters encodes to up to 4x its
   * string length, so a UTF-16 `.length` check would wave a 2 MB body through.
   */
  /*
   * Repro apps/ui/canary-repros/chat/4.13: every model call replays the whole
   * transcript, so an over-cap body is a fact about the CONVERSATION. The turn
   * seam said so; the relay — which carries every turn now that the browser
   * chain is the only backend — answered the bare "Request body is too large."
   * Both doors say the same sentence, and it names the way out.
   */
  test("both model doors answer an over-cap transcript with the same actionable 413", async () => {
    const oversize = { role: "user", content: "x".repeat(1100 * 1024) }
    for (
      const request of [
        post("/api/agent/turn", { ...turnBody, messages: [oversize] }),
        post("/api/model/stream", { messages: [oversize] })
      ]
    ) {
      const response = await worker.fetch(request, assetsEnv())
      expect(response.status).toBe(413)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("This conversation has grown too long")
      expect(body.message).toContain("Start a new conversation")
      expect(body.message).not.toBe("Request body is too large.")
    }
  })

  test("measures the 1 MB cap in bytes, not UTF-16 code units", async () => {
    // 768k x U+00E9 = 768k code units but 1.5 MB of UTF-8.
    const instructions = "é".repeat(768 * 1024)
    expect(instructions.length).toBeLessThan(1024 * 1024)
    expect(new TextEncoder().encode(instructions).byteLength).toBeGreaterThan(1024 * 1024)
    const response = await worker.fetch(
      post("/api/agent/turn", { ...turnBody, instructions }),
      assetsEnv()
    )
    expect(response.status).toBe(413)
  })

  /*
   * Repro apps/ui/canary-repros/chat/4.13: every turn replays the whole
   * transcript, so at the old 64 KB cap seven long answers wedged the seam
   * permanently — and `/clear`, which runs a model turn of its own to decide
   * what to keep, hit the same refusal, so the conversation had no in-app
   * escape. The measured wedge was ~64 KB of rendered transcript.
   */
  test("accepts a transcript the size that wedged the seam at the old cap", async () => {
    const upstream: Array<string> = []
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      upstream.push(String(input))
      return new Response("{\"type\":\"done\"}\n", { headers: { "content-type": "application/x-ndjson" } })
    }) as typeof fetch
    try {
      const messages = Array.from({ length: 14 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(6 * 1024)
      }))
      const response = await worker.fetch(
        post("/api/agent/turn", { ...turnBody, runId: "run-4-13-wedge", messages }),
        env
      )
      expect(response.status).toBe(200)
      // Drain so the per-isolate active-turn entry settles for later tests.
      await response.text()
      expect(upstream).toEqual(["https://upstream.test/chat"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  /* A refusal a reader can act on: which thing is too long, and the way out. */
  test("the oversize refusal names the conversation and the way out", async () => {
    const response = await worker.fetch(
      post("/api/agent/turn", { ...turnBody, instructions: "x".repeat(1100 * 1024) }),
      assetsEnv()
    )
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("conversation")
    expect(body.message).toContain("Start a new conversation")
    expect(body.message).not.toBe("Request body is too large.")
  })

  /*
   * Repro apps/ui/canary-repros/honesty/24.3: the seam pasted the upstream's
   * body onto a fixed prefix, so a provider's rate-limit envelope arrived in
   * the transcript as raw JSON. The status is classified here rather than
   * trusting every upstream to write prose for a human.
   */
  test("a rate-limited upstream becomes a rate-limit sentence, not raw provider JSON", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Number of request tokens has exceeded your per-minute rate limit"
          }
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "45" } }
      )) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-429" }), env)
      expect(response.status).toBe(429)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("rate-limiting")
      expect(body.message).toContain("Nothing was charged")
      expect(body.message).toContain("45 seconds")
      expect(body.message).not.toContain("rate_limit_error")
      expect(body.message).not.toContain("{")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * The §24.4 shape from the same repro: a Worker 500 whose body is a
   * Cloudflare HTML page rendered as markup in the transcript.
   */
  test("an upstream HTML error page never reaches the message", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const original = globalThis.fetch
    globalThis.fetch =
      (async () =>
        new Response("<!DOCTYPE html><html><body>Error 1101 Worker threw exception</body></html>", {
          status: 500,
          headers: { "content-type": "text/html" }
        })) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-500" }), env)
      expect(response.status).toBe(500)
      const body = (await response.json()) as { message: string }
      expect(body.message).not.toContain("<")
      expect(body.message).toContain("having trouble")
    } finally {
      globalThis.fetch = original
    }
  })

  /* An upstream that DOES write prose keeps it — our own limiter is the case. */
  test("an upstream message written for a reader survives", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "error", message: "The canary chat queue is draining; try again shortly." }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      )) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-503" }), env)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("The canary chat queue is draining")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * An unreachable sibling used to end the fetch handler with an uncaught
   * rejection, and workerd answers that with its own HTML error page — which
   * the product then renders to the user.
   */
  test("an unreachable proxy upstream answers honest JSON, never a thrown exception", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      BILLING_UPSTREAM_URL: "https://billing.test"
    }
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new TypeError("Network connection lost.")
    }) as unknown as typeof fetch
    try {
      for (const path of ["/api/identity/whoami", "/api/billing/balance"]) {
        const response = await worker.fetch(new Request(`https://mvp.test${path}`), env)
        expect(`${path} → ${response.status}`).toBe(`${path} → 502`)
        const body = (await response.json()) as { status: string; message: string }
        expect(body.status).toBe("error")
        expect(body.message).toContain("unreachable")
      }
    } finally {
      globalThis.fetch = original
    }
  })

  test("streams one upstream turn through /api/agent/turn as NDJSON", async () => {
    let upstreamCall: { origin: string | null; runId: string | null; body: unknown } | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat"
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "https://upstream.test/chat") {
        upstreamCall = {
          origin: new Headers(init?.headers).get("origin"),
          runId: new Headers(init?.headers).get("x-smithers-run-id"),
          body: JSON.parse(String(init?.body))
        }
        return ndjsonUpstream([
          { type: "delta", kind: "text", text: "Hi, I'm Smithers." },
          { type: "done" }
        ])
      }
      return originalFetch(input as Request, init)
    }) as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", turnBody), env)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/x-ndjson")
      const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
      // The Worker stamps the turn's runId onto every upstream frame — the
      // client's stream reader drops frames that don't name their turn.
      expect(lines).toEqual([
        { runId: "run-1", type: "delta", kind: "text", text: "Hi, I'm Smithers." },
        { runId: "run-1", type: "done" }
      ])
      expect(upstreamCall?.origin).toBe("https://smithers.sh")
      expect(upstreamCall?.runId).not.toBe("run-1")
      expect(upstreamCall?.runId).toMatch(/^[0-9a-f-]{36}$/)
      expect(upstreamCall?.body).toEqual({
        messages: turnBody.messages,
        instructions: turnBody.instructions
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("attaches the configured deployment credential to the chat upstream, never a client one", async () => {
    let authorization: string | null | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      SMITHERS_CHAT_AUTH_TOKEN: "deployment-chat-token"
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "https://upstream.test/chat") {
        authorization = new Headers(init?.headers).get("authorization")
        return ndjsonUpstream([{ type: "done" }])
      }
      return originalFetch(input as Request, init)
    }) as typeof fetch
    try {
      const withClientBearer = new Request("http://localhost/api/agent/turn", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer client-picked-token" },
        body: JSON.stringify(turnBody)
      })
      const response = await worker.fetch(withClientBearer, env)
      expect(response.status).toBe(200)
      await response.text()
      // The upstream authenticates the deployment, never the browser.
      expect(authorization).toBe("Bearer deployment-chat-token")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("cancel reports not-found for an unknown run", async () => {
    const response = await worker.fetch(post("/api/agent/turn/cancel", { runId: "nope" }), assetsEnv())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "not-found" })
  })

  test("retired raw gateway mounts return an explicit migration response", async () => {
    for (const path of ["/rpc", "/projections", "/sync", "/health"]) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`), assetsEnv())
      expect(response.status).toBe(410)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("/api/workflow/rpc")
    }
  })

  test("WebSocket upgrades on retired or unknown mounts never activate a proxy", async () => {
    let upstreamCalls = 0
    const env = assetsEnv()
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "gateway.test") return undefined
        upstreamCalls += 1
        return new Response("{}", { status: 200 })
      },
      async () => {
        const probe = await worker.fetch(
          new Request("https://mvp.test/api/not-a-gateway-route", { headers: { upgrade: "websocket" } }),
          env
        )
        expect(probe.status).toBe(404)
        expect(upstreamCalls).toBe(0)
        // Former raw mounts name their retirement; they do not forward either.
        const forwarded = await worker.fetch(
          new Request("https://mvp.test/rpc", { headers: { upgrade: "websocket" } }),
          env
        )
        expect(forwarded.status).toBe(410)
        expect(upstreamCalls).toBe(0)
      }
    )
  })
})

const withMockedFetchResult = async <T>(
  handler: (request: Request) => Response | Promise<Response> | undefined,
  run: () => Promise<T>
): Promise<T> => {
  let result: T | undefined
  await withMockedFetch(handler, async () => {
    result = await run()
  })
  return result as T
}

const withMockedFetch = async (
  handler: (request: Request) => Response | Promise<Response> | undefined,
  run: () => Promise<void>
): Promise<void> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = typeof input === "string"
      ? new Request(input, init)
      : input instanceof URL
      ? new Request(input.toString(), init)
      : (input as Request)
    const mocked = handler(request)
    if (mocked !== undefined) return mocked
    return originalFetch(request)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe("identity seam", () => {
  test("auth and identity routes 501 honestly when no upstream is configured", async () => {
    for (const path of ["/api/auth/session", "/api/auth/scopes", "/api/identity/request-access"]) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`), assetsEnv())
      expect(response.status).toBe(501)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("IDENTITY_UPSTREAM_URL")
    }
  })

  test("proxies to the identity upstream, stripping client identity headers but keeping cookies", async () => {
    let seen: { url: string; headers: Headers } | undefined
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "identity.test") return undefined
        seen = { url: request.url, headers: request.headers }
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/session", {
            headers: { cookie: "smithers_session=abc", "x-user-id": "evil", authorization: "Bearer forged" }
          }),
          env
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ login: "will", allowlisted: true, admin: false })
        expect(seen?.url).toBe("https://identity.test/api/auth/session")
        expect(seen?.headers.get("cookie")).toBe("smithers_session=abc")
        expect(seen?.headers.get("x-user-id")).toBeNull()
        expect(seen?.headers.get("authorization")).toBeNull()
        // A same-origin GET carries no Origin of its own, and both sibling
        // workers gate on one, so the proxy states the origin it serves.
        expect(seen?.headers.get("origin")).toBe("https://mvp.test")
      }
    )
  })
})

/**
 * Wave 8 — no dead ends on the OAuth navigation routes: a browser that clicks
 * "Sign in with GitHub" must never land on raw JSON, and a machine caller
 * keeps the machine answer. Plus the signed-out session probe: the expected
 * 401 is restated as a resolved 200 so the browser logs no console error.
 */
describe("auth navigation seam (wave 8)", () => {
  const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
  const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

  const withIdentity = (
    answer: (request: Request) => Response,
    run: () => Promise<void>
  ): Promise<void> =>
    withMockedFetch(
      (request) => (new URL(request.url).hostname === "identity.test" ? answer(request) : undefined),
      run
    )

  test("a 503 from the OAuth start route renders the branded honest page, status preserved", async () => {
    await withIdentity(
      () =>
        new Response(JSON.stringify({ error: "not configured", code: "oauth_not_configured" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
          env
        )
        expect(response.status).toBe(503)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        expect(html).toContain("GitHub sign-in isn't switched on yet for this preview.")
        expect(html).toContain("href=\"/\"")
        // Self-contained: no external asset references.
        expect(html).not.toContain("<script")
        expect(html).not.toContain("http://")
        expect(html).not.toContain("https://")
      }
    )
  })

  test("Accept: application/json keeps the machine-readable upstream answer verbatim", async () => {
    await withIdentity(
      () =>
        new Response(JSON.stringify({ error: "not configured", code: "oauth_not_configured" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", {
            headers: { accept: "application/json" }
          }),
          env
        )
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: "not configured", code: "oauth_not_configured" })
      }
    )
  })

  test("a failed callback never strands a user on JSON either", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ error: "upstream broke" }), { status: 500 }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/callback?code=x&state=y", {
            headers: { accept: BROWSER_ACCEPT }
          }),
          env
        )
        expect(response.status).toBe(500)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        expect(html).toContain("GitHub sign-in didn't finish.")
        expect(html).toContain("HTTP 500")
        expect(html).toContain("href=\"/\"")
      }
    )
  })

  /*
   * Repro apps/ui/canary-repros/access/2.3: pressing Cancel on GitHub's
   * consent screen returns `?error=access_denied` with no `code`. That was
   * forwarded to identity, which read it as a malformed callback, and the page
   * told the user "the sign-in service answered HTTP 400" — blaming a service
   * for a button they pressed. The cause is in the query string, so it is read
   * here, named here, and never spends an upstream call.
   */
  test("a cancelled consent screen is named as a cancellation, not an upstream failure", async () => {
    let upstreamCalls = 0
    await withIdentity(
      () => {
        upstreamCalls += 1
        return new Response(JSON.stringify({ message: "code and state are required" }), { status: 400 })
      },
      async () => {
        const response = await worker.fetch(
          new Request(
            "https://mvp.test/api/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=zzz",
            { headers: { accept: BROWSER_ACCEPT } }
          ),
          env
        )
        // Nothing failed: the user declined and the app did as it was told.
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        expect(html).toContain("You cancelled the GitHub sign-in.")
        expect(html).toContain("Nothing was signed in")
        expect(html).not.toContain("sign-in service answered")
        expect(html).not.toContain("HTTP 400")
        expect(html).toContain("href=\"/\"")
        expect(upstreamCalls).toBe(0)
      }
    )
  })

  test("any other OAuth error names what GitHub called it, and keeps a 400", async () => {
    await withIdentity(
      () => new Response("{}", { status: 400 }),
      async () => {
        const response = await worker.fetch(
          new Request(
            "https://mvp.test/api/auth/github/callback?error=redirect_uri_mismatch&error_description=The+redirect_uri+is+not+associated.&state=zzz",
            { headers: { accept: BROWSER_ACCEPT } }
          ),
          env
        )
        expect(response.status).toBe(400)
        const html = await response.text()
        expect(html).toContain("redirect_uri_mismatch")
        expect(html).toContain("The redirect_uri is not associated.")
        expect(html).toContain("href=\"/\"")
      }
    )
  })

  test("markup in the OAuth error query params is escaped into inert text, never rendered", async () => {
    await withIdentity(
      () => new Response("{}", { status: 400 }),
      async () => {
        const payload = "<script>alert(1)</script>"
        const description = "</p><img src=x onerror='alert(2)'>&\""
        const response = await worker.fetch(
          new Request(
            `https://mvp.test/api/auth/github/callback?error=${encodeURIComponent(payload)}&error_description=${encodeURIComponent(description)}&state=zzz`,
            { headers: { accept: BROWSER_ACCEPT } }
          ),
          env
        )
        expect(response.status).toBe(400)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        expect(html).not.toContain(payload)
        expect(html).not.toContain("<script")
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
        expect(html).not.toContain("<img")
        expect(html).toContain("&lt;/p&gt;&lt;img src=x onerror=&#39;alert(2)&#39;&gt;&amp;&quot;")
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
      }
    )
  })

  test("a cancelled callback answers JSON callers a cancellation too", async () => {
    await withIdentity(
      () => new Response("{}", { status: 400 }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/callback?error=access_denied&state=zzz", {
            headers: { accept: "application/json" }
          }),
          env
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; message: string }
        expect(body.status).toBe("cancelled")
        expect(body.message).toContain("Nothing was signed in")
      }
    )
  })

  test("the redirect happy path passes through untouched", async () => {
    await withIdentity(
      () => new Response(null, { status: 302, headers: { location: "https://github.com/login/oauth" } }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
          env
        )
        expect(response.status).toBe(302)
        expect(response.headers.get("location")).toBe("https://github.com/login/oauth")
      }
    )
  })

  test("an unreachable identity upstream renders the honest page (502), never a thrown 500", async () => {
    await withIdentity(
      () => {
        throw new Error("connection refused")
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
          env
        )
        expect(response.status).toBe(502)
        expect(response.headers.get("content-type")).toContain("text/html")
        expect(await response.text()).toContain("href=\"/\"")
      }
    )
  })

  test("with no identity seam at all a browser still gets the honest page, a machine the JSON 501", async () => {
    const browser = await worker.fetch(
      new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
      assetsEnv()
    )
    expect(browser.status).toBe(501)
    expect(browser.headers.get("content-type")).toContain("text/html")
    expect(await browser.text()).toContain("GitHub sign-in isn't switched on yet for this preview.")
    const machine = await worker.fetch(
      new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "application/json" } }),
      assetsEnv()
    )
    expect(machine.status).toBe(501)
    expect((await machine.json()) as { message: string }).toBeTruthy()
  })

  test("the signed-out session probe resolves 200, never the console-error 401", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ status: "error", message: "signed out" }), { status: 401 }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: "signed-out" })
      }
    )
  })

  // The identity worker spends 403 on "Forbidden origin" only — a deployment
  // whose ALLOWED_ORIGINS omits this Worker, where nobody could sign in. That
  // is a real failure, not the signed-out state, so it must still surface.
  test("a forbidden-origin 403 is NOT restated as signed-out", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ error: "Forbidden origin" }), { status: 403 }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: "Forbidden origin" })
      }
    )
  })

  test("real session-probe failures (5xx) pass through untouched", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ status: "error" }), { status: 500 }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(500)
      }
    )
  })

  test("a signed-in session answer passes through untouched", async () => {
    await withIdentity(
      () =>
        new Response(JSON.stringify({ login: "will", allowlisted: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ login: "will", allowlisted: true })
      }
    )
  })
})

/*
 * The sign-in return path. A sign-in started from `/smithersai/smithers`
 * finished on `/?signed-in=github` (a real round trip on smithers.sh): the
 * identity worker knows one landing. The page that asked travels as
 * `?return_to=` on the start route, waits in a short-lived cookie scoped to
 * the OAuth legs, and the callback's success redirect goes back there with
 * the same marker. The value becomes a redirect, so every off-origin shape is
 * dropped and the callback lands where it always did.
 */
describe("sign-in return path", () => {
  const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
  const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  const COOKIE = "smithers_return_to"

  const identityRedirect = (location: string, request: Request): Response | undefined =>
    new URL(request.url).hostname === "identity.test"
      ? new Response(null, { status: 302, headers: { location } })
      : undefined

  const start = (query: string, seen: Request[] = []): Promise<Response> =>
    withMockedFetchResult(
      (request) => {
        seen.push(request)
        return identityRedirect("https://github.com/login/oauth/authorize?state=s", request)
      },
      () =>
        worker.fetch(new Request(`https://mvp.test/api/auth/github/start${query}`, { headers: { accept: BROWSER_ACCEPT } }), env)
    )

  const callback = (cookie: string | undefined, location = "/?signed-in=github"): Promise<Response> =>
    withMockedFetchResult(
      (request) => identityRedirect(location, request),
      () =>
        worker.fetch(
          new Request("https://mvp.test/api/auth/github/callback?code=x&state=s", {
            headers: { accept: BROWSER_ACCEPT, ...(cookie === undefined ? {} : { cookie }) }
          }),
          env
        )
    )

  const setCookies = (response: Response): ReadonlyArray<string> => response.headers.getSetCookie()
  const returnToCookie = (response: Response): string | undefined =>
    setCookies(response).find((cookie) => cookie.startsWith(`${COOKIE}=`))

  test("a repository page round-trips: cookie on start, redirect on callback, cookie cleared", async () => {
    const seen: Request[] = []
    const started = await start("?return_to=%2Fsmithersai%2Fsmithers", seen)
    expect(started.status).toBe(302)
    expect(started.headers.get("location")).toBe("https://github.com/login/oauth/authorize?state=s")
    const cookie = returnToCookie(started)
    expect(cookie).toBe(
      `${COOKIE}=%2Fsmithersai%2Fsmithers; Path=/api/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
    )
    // The identity worker never sees the page (and GitHub never sees it in the state).
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]!.url).searchParams.has("return_to")).toBe(false)

    const returned = await callback(`other=1; ${COOKIE}=%2Fsmithersai%2Fsmithers`)
    expect(returned.status).toBe(302)
    expect(returned.headers.get("location")).toBe("/smithersai/smithers?signed-in=github")
    expect(returnToCookie(returned)).toBe(`${COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
  })

  test("the page's own query survives and identity's marker is appended when its redirect carries none", async () => {
    const returned = await callback(`${COOKIE}=%2Fsmithersai%2Fsmithers%3Ftab%3Dissues`, "/")
    expect(returned.headers.get("location")).toBe("/smithersai/smithers?tab=issues&signed-in=github")
  })

  test("an off-origin identity redirect is replaced by the return page, never followed with its query", async () => {
    const returned = await callback(`${COOKIE}=%2Fsmithersai%2Fsmithers`, "https://canary.smithers.sh/?signed-in=github&x=1")
    expect(returned.headers.get("location")).toBe("/smithersai/smithers?signed-in=github")
  })

  test("without a cookie the callback lands where it always did", async () => {
    const returned = await callback(undefined)
    expect(returned.status).toBe(302)
    expect(returned.headers.get("location")).toBe("/?signed-in=github")
    expect(setCookies(returned)).toEqual([])
  })

  test("a start without return_to sets no cookie", async () => {
    const started = await start("")
    expect(started.status).toBe(302)
    expect(setCookies(started)).toEqual([])
  })

  test.each([
    ["an absolute URL", "https://evil.example/"],
    ["a protocol-relative URL", "//evil.example/"],
    ["a backslash after the slash", "/\\evil.example"],
    ["a backslash anywhere", "/smithersai\\evil"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a newline", "/smithersai/smithers\nSet-Cookie: x=y"],
    ["a carriage return", "/smithersai/smithers\r"],
    ["a relative path", "smithersai/smithers"],
    ["the landing page itself", "/"],
    ["an API route", "/api/auth/github/start"],
    ["a value over 512 bytes", `/${"a".repeat(512)}`]
  ])("start ignores %s", async (_label, value) => {
    const started = await start(`?return_to=${encodeURIComponent(value)}`)
    expect(started.status).toBe(302)
    expect(setCookies(started)).toEqual([])
  })

  test.each([
    ["an absolute URL", "https://evil.example/"],
    ["a protocol-relative URL", "//evil.example/"],
    ["a backslash after the slash", "/\\evil.example"],
    ["a newline", "/smithersai/smithers\nx"]
  ])("a tampered cookie carrying %s falls back to the landing page and is cleared", async (_label, value) => {
    const returned = await callback(`${COOKIE}=${encodeURIComponent(value)}`)
    expect(returned.status).toBe(302)
    expect(returned.headers.get("location")).toBe("/?signed-in=github")
    expect(returnToCookie(returned)).toContain("Max-Age=0")
  })

  test("a cancelled consent screen still lands on the cancellation page, cookie or not", async () => {
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "identity.test") return undefined
        upstreamCalls += 1
        return new Response("{}", { status: 400 })
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/callback?error=access_denied&state=zzz", {
            headers: { accept: BROWSER_ACCEPT, cookie: `${COOKIE}=%2Fsmithersai%2Fsmithers` }
          }),
          env
        )
        expect(response.status).toBe(200)
        expect(response.headers.get("location")).toBeNull()
        expect(await response.text()).toContain("You cancelled the GitHub sign-in.")
        expect(upstreamCalls).toBe(0)
      }
    )
  })

  test("a failed exchange keeps the honest error page and never redirects to the return page", async () => {
    await withMockedFetch(
      (request) =>
        new URL(request.url).hostname === "identity.test"
          ? new Response(JSON.stringify({ error: "bad state" }), { status: 400 })
          : undefined,
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/callback?code=x&state=s", {
            headers: { accept: BROWSER_ACCEPT, cookie: `${COOKIE}=%2Fsmithersai%2Fsmithers` }
          }),
          env
        )
        expect(response.status).toBe(400)
        expect(response.headers.get("location")).toBeNull()
        expect(await response.text()).toContain("GitHub sign-in didn't finish.")
      }
    )
  })
})

/**
 * Wave 7 published this Worker at canary.smithers.sh, where `/api/agent/turn`
 * spends the deployment's model credential and meters real dollars. The
 * same-origin guard is not a gate against that: it only fires for a request
 * that sends an `Origin`, so a plain curl walked straight into a live turn.
 * Once an identity seam exists, the turn routes require a session.
 */
describe("turn seam session gate", () => {
  const identityEnv: WorkerEnv = {
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    SMITHERS_CHAT_URL: "https://upstream.test/chat"
  }

  test("refuses an anonymous turn with 401 before any credential is spent", async () => {
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response("{}", { status: 401 })
        }
        upstreamCalls += 1
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(post("/api/agent/turn", turnBody), identityEnv)
        expect(response.status).toBe(401)
        // Killing a turn spends nothing, so a signed-out caller may ask; an
        // unknown run is an honest not-found, never a sign-in demand.
        const cancel = await worker.fetch(post("/api/agent/turn/cancel", { runId: "run-nobody" }), identityEnv)
        expect(cancel.status).toBe(200)
        expect(((await cancel.json()) as { status: string }).status).toBe("not-found")
      }
    )
    expect(upstreamCalls).toBe(0)
  })

  test("maps an identity outage to 502 instead of a false sign-in 401", async () => {
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") throw new Error("connection reset")
        return undefined
      },
      async () => {
        const response = await worker.fetch(post("/api/agent/turn", turnBody), identityEnv)
        expect(response.status).toBe(502)
        expect(((await response.json()) as { message: string }).message).toContain("unreachable")
      }
    )
  })

  test("maps an identity deadline to 504 instead of a false sign-in 401", async () => {
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "identity.test") return undefined
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
        })
      },
      async () => {
        const response = await worker.fetch(post("/api/agent/turn", turnBody), {
          ...identityEnv,
          UPSTREAM_TIMEOUT_MS: "1"
        })
        expect(response.status).toBe(504)
      }
    )
  })

  test("refuses a signed-in but non-allowlisted account with 403", async () => {
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response(JSON.stringify({ login: "stranger", allowlisted: false }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        upstreamCalls += 1
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(post("/api/agent/turn", turnBody), identityEnv)
        expect(response.status).toBe(403)
      }
    )
    expect(upstreamCalls).toBe(0)
  })

  test("lets a validated allowlisted session through to the live turn", async () => {
    await withMockedFetch(
      (request) =>
        new URL(request.url).hostname === "identity.test"
          ? new Response(JSON.stringify({ login: "will", allowlisted: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
          : ndjsonUpstream([
            { type: "delta", kind: "text", text: "ok" },
            { type: "done" }
          ]),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/agent/turn", {
            method: "POST",
            headers: { "content-type": "application/json", cookie: "smithers_session=abc" },
            body: JSON.stringify({ ...turnBody, runId: "run-gated" })
          }),
          identityEnv
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("\"type\":\"done\"")
      }
    )
  })

  /**
   * Wave 13 (D-2): a session-gated turn vouches the validated login to the
   * chat worker with the trusted-caller pair, so the turn's metered charge
   * lands on the user's OWN account. A client-supplied pair is never
   * forwarded — the upstream headers are built here.
   */
  test("a session-gated turn attaches the trusted-caller pair; an unseamed turn attaches nothing", async () => {
    let seen: Headers | undefined
    const env: WorkerEnv = {
      ...identityEnv,
      CHAT_PRODUCT_SERVICE_TOKEN: "chat-product-token-123",
      SMITHERS_CHAT_AUTH_TOKEN: "chat-bearer-123"
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response(JSON.stringify({ login: "will", allowlisted: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        seen = request.headers
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/agent/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "smithers_session=abc",
              // A client trying to attribute its turn to someone else.
              "x-user-login": "someone-else",
              "x-smithers-service-token": "forged"
            },
            body: JSON.stringify({ ...turnBody, runId: "run-vouched" })
          }),
          env
        )
        expect(response.status).toBe(200)
        await response.text()
      }
    )
    expect(seen?.get("x-user-login")).toBe("will")
    expect(seen?.get("x-smithers-service-token")).toBe("chat-product-token-123")
    expect(seen?.get("authorization")).toBe("Bearer chat-bearer-123")

    let unseamed: Headers | undefined
    await withMockedFetch(
      (request) => {
        unseamed = request.headers
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          post("/api/agent/turn", { ...turnBody, runId: "run-unvouched" }),
          { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
        )
        expect(response.status).toBe(200)
        await response.text()
      }
    )
    expect(unseamed?.get("x-user-login")).toBeNull()
    expect(unseamed?.get("x-smithers-service-token")).toBeNull()
  })

  /**
   * The local dev / stub stack has no identity seam at all, so there is nothing
   * that could authenticate anyone — the gate must not brick it.
   */
  test("stays out of the way when no identity seam is configured", async () => {
    await withMockedFetch(
      () => ndjsonUpstream([{ type: "done" }]),
      async () => {
        const response = await worker.fetch(
          post("/api/agent/turn", { ...turnBody, runId: "run-ungated" }),
          { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
        )
        expect(response.status).toBe(200)
      }
    )
  })
})

/*
 * Anonymous exploring (PUBLIC-REPOSITORIES.md): at smithers.sh/smithersai/smithers
 * a signed-out visitor talks to Smithers about that repository. The door is
 * the turn's own runtime context naming a catalog repository; nothing else a
 * signed-out caller can send opens it, and no write route moves.
 */
describe("anonymous exploring of a public catalog repository", () => {
  const identityEnv: WorkerEnv = {
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    SMITHERS_CHAT_URL: "https://upstream.test/chat",
    CHAT_PRODUCT_SERVICE_TOKEN: "chat-product-token-123",
    SMITHERS_CHAT_AUTH_TOKEN: "chat-bearer-123"
  }

  const exploring = (activeRepository: string | null, runId: string) => ({
    ...turnBody,
    runId,
    context: {
      version: 1,
      product: "smithers",
      capturedAt: 1786223000000,
      revision: 3,
      surface: "chat",
      theme: "light",
      selectedWorldDocument: null,
      connectors: [],
      activeRepository,
      github: { connected: false, login: null, repositories: null },
      worldState: { documentCount: 0, documents: [] },
      capabilities: [],
      limitations: []
    }
  })

  const signedOut = (request: Request): Response | undefined =>
    new URL(request.url).hostname === "identity.test" ? new Response("{}", { status: 401 }) : undefined

  test("identity answering a cookieless validate with a loginless 200 is signed out, not an outage", async () => {
    // Production identity answers a validate that carries no cookie with 200
    // and a session body without a login; that must open the anonymous door
    // exactly like a 401, never the 502 "malformed session" outage.
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          expect(request.headers.has("cookie")).toBe(false)
          return Response.json({ state: "signed-out", login: null })
        }
        upstreamCalls += 1
        return ndjsonUpstream([{ type: "delta", kind: "text", text: "It is a monorepo." }, { type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://canary.smithers.sh/api/agent/turn", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://canary.smithers.sh" },
            body: JSON.stringify(exploring("smithersai/smithers", "run-loginless"))
          }),
          identityEnv
        )
        expect(response.status).toBe(200)
        expect(upstreamCalls).toBe(1)
      }
    )
  })

  test("a signed-out turn about a catalog repository runs, unattributed to any account", async () => {
    let seen: Headers | undefined
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        const refusal = signedOut(request)
        if (refusal !== undefined) return refusal
        upstreamCalls += 1
        seen = request.headers
        return ndjsonUpstream([{ type: "delta", kind: "text", text: "It is a monorepo." }, { type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          post("/api/agent/turn", exploring("SmithersAI/Smithers", "explore-catalog-1")),
          identityEnv
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("It is a monorepo.")
      }
    )
    expect(upstreamCalls).toBe(1)
    // The deployment credential runs the turn; no login is vouched, so the
    // chat upstream meters it to the deployment and never to a person.
    expect(seen?.get("authorization")).toBe("Bearer chat-bearer-123")
    expect(seen?.get("x-user-login")).toBeNull()
    expect(seen?.get("x-smithers-service-token")).toBeNull()
  })

  test("a signed-out turn about anything else, or about nothing, keeps the sign-in 401", async () => {
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        const refusal = signedOut(request)
        if (refusal !== undefined) return refusal
        upstreamCalls += 1
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        for (const body of [exploring("someone/private", "explore-private"), exploring(null, "explore-none"), turnBody]) {
          const response = await worker.fetch(post("/api/agent/turn", body), identityEnv)
          expect(response.status).toBe(401)
          expect(((await response.json()) as { message: string }).message).toBe("Sign in to run a Smithers turn.")
        }
      }
    )
    expect(upstreamCalls).toBe(0)
  })

  test("every write route still answers the sign-in 401 to a signed-out caller", async () => {
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        const refusal = signedOut(request)
        if (refusal !== undefined) return refusal
        upstreamCalls += 1
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const env: WorkerEnv = { ...identityEnv, SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
        const writes: ReadonlyArray<[string, unknown]> = [
          ["/api/model/stream", { messages: [{ role: "user", content: "hi" }] }],
          ["/api/workflow/rpc", { repo: "smithersai/smithers", procedure: "Run.Start", payload: {} }],
          ["/api/workflow/provision", { repo: "smithersai/smithers" }],
          ["/api/repos/smithersai/smithers/issues", { title: "anonymous write" }],
          ["/api/cloud/api/repos/smithersai/smithers/issues", { title: "anonymous write" }],
          ["/api/tools/browser-fetch", { url: "https://example.com" }]
        ]
        for (const [path, body] of writes) {
          const response = await worker.fetch(post(path, body), env)
          expect([path, response.status]).toEqual([path, 401])
          expect(((await response.json()) as { message: string }).message).toMatch(/^Sign in /)
        }
      }
    )
    expect(upstreamCalls).toBe(0)
  })
})

/**
 * The API spends this deployment's own credentials, and a `text/plain` POST from
 * another site is not preflighted — so without a same-origin guard any page
 * anywhere could submit an approval decision under the seam's injected identity.
 */
describe("same-origin guard", () => {
  const crossOrigin = (path: string): Request =>
    new Request(`https://mvp.test${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: "{}"
    })

  test("refuses cross-origin API requests before any credential is spent", async () => {
    let upstreamCalls = 0
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      SMITHERS_CHAT_URL: "https://upstream.test/chat"
    }
    await withMockedFetch(
      () => {
        upstreamCalls += 1
        return new Response("{}", { status: 200 })
      },
      async () => {
        for (
          const path of [
            "/api/workflow/rpc",
            "/api/agent/turn",
            "/api/auth/session",
            "/api/identity/request-access",
            "/api/billing/balance",
            "/rpc"
          ]
        ) {
          const response = await worker.fetch(crossOrigin(path), env)
          expect(response.status).toBe(403)
        }
      }
    )
    expect(upstreamCalls).toBe(0)
  })

  test("same-origin requests, and requests with no Origin at all, still pass", async () => {
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    await withMockedFetch(
      (request) =>
        new URL(request.url).hostname === "identity.test"
          ? new Response("{}", { status: 200 })
          : undefined,
      async () => {
        const sameOrigin = await worker.fetch(
          new Request("https://mvp.test/api/auth/session", { headers: { origin: "https://mvp.test" } }),
          env
        )
        expect(sameOrigin.status).toBe(200)
        const noOrigin = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(noOrigin.status).toBe(200)
      }
    )
  })
})

describe("billing seam", () => {
  test("billing routes 501 honestly when no upstream is configured", async () => {
    const response = await worker.fetch(new Request("https://mvp.test/api/billing/balance"), assetsEnv())
    expect(response.status).toBe(501)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("BILLING_UPSTREAM_URL")
  })

  /**
   * `workers/billing` authenticates the account with a Smithers Cloud user
   * bearer and reads no `x-user-*` claim, so forwarding without one could only
   * ever come back 401 — the seam says so instead of pretending.
   */
  test("501s honestly when billing has an upstream but no account bearer", async () => {
    const response = await worker.fetch(new Request("https://mvp.test/api/billing/balance"), {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test"
    })
    expect(response.status).toBe(501)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("BILLING_AUTH_TOKEN")
  })

  test("validates the session and bills AS THE USER through the trusted-caller path", async () => {
    const calls: Array<{ host: string; path: string; headers: Headers }> = []
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      BILLING_PRODUCT_SERVICE_TOKEN: "product-service-token-123",
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "service-token-123"
    }
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test") {
          calls.push({ host: "identity", path: url.pathname, headers: request.headers })
          return new Response(
            JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: ["billing:read"] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        }
        if (url.hostname === "billing.test") {
          calls.push({ host: "billing", path: url.pathname, headers: request.headers })
          return new Response(JSON.stringify({ state: "ok", allowedToStartWork: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        return undefined
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/billing/balance", {
            headers: {
              cookie: "smithers_session=abc",
              "x-user-id": "evil",
              "x-user-login": "evil",
              "x-smithers-service-token": "evil"
            }
          }),
          env
        )
        expect(response.status).toBe(200)
        const validate = calls.find((call) => call.host === "identity")
        expect(validate?.path).toBe("/api/identity/validate")
        expect(validate?.headers.get("x-smithers-service-token")).toBe("service-token-123")
        expect(validate?.headers.get("cookie")).toBe("smithers_session=abc")
        const balance = calls.find((call) => call.host === "billing")
        expect(balance?.path).toBe("/api/billing/balance")
        // The trusted-caller contract: the product service token plus the
        // identity-validated login — billing keys the account by that login.
        expect(balance?.headers.get("x-smithers-service-token")).toBe("product-service-token-123")
        expect(balance?.headers.get("x-user-login")).toBe("will")
        expect(balance?.headers.get("x-user-scopes")).toBe("billing:read")
        // The deployment bearer must NOT ride along: billing's bearer-wins
        // rule would re-key the read to the shared account (the wave-13 D-1
        // defect). And no client-supplied claim survives the strip.
        expect(balance?.headers.get("authorization")).toBeNull()
        expect(balance?.headers.get("origin")).toBe("https://mvp.test")
      }
    )
  })

  test("a signed-in request with no product service token 501s honestly — never silently bills the shared account", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      IDENTITY_UPSTREAM_URL: "https://identity.test"
    }
    let billingCalls = 0
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test") {
          return new Response(JSON.stringify({ login: "will", allowlisted: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        if (url.hostname === "billing.test") {
          billingCalls += 1
          return new Response("{}", { status: 200 })
        }
        return undefined
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/billing/balance", { headers: { cookie: "smithers_session=abc" } }),
          env
        )
        expect(response.status).toBe(501)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("BILLING_PRODUCT_SERVICE_TOKEN")
      }
    )
    expect(billingCalls).toBe(0)
  })

  test("a client-supplied bearer never reaches billing — only the deployment's does", async () => {
    let seen: Headers | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123"
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "billing.test") return undefined
        seen = request.headers
        return new Response("{}", { status: 200 })
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/billing/balance", {
            headers: {
              authorization: "Bearer someone-elses-account",
              "x-user-id": "evil",
              "x-user-login": "evil",
              "x-smithers-service-token": "evil"
            }
          }),
          env
        )
        expect(response.status).toBe(200)
        expect(seen?.get("authorization")).toBe("Bearer cloud-bearer-123")
        expect(seen?.get("x-user-id")).toBeNull()
        expect(seen?.get("x-user-login")).toBeNull()
        expect(seen?.get("x-smithers-service-token")).toBeNull()
      }
    )
  })

  test("401s honestly when the identity seam validates no session", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      IDENTITY_UPSTREAM_URL: "https://identity.test"
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response(JSON.stringify({ status: "error" }), { status: 401 })
        }
        return undefined
      },
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/billing/balance"), env)
        expect(response.status).toBe(401)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("Sign in")
      }
    )
  })
})

describe("the deleted approval-decision route", () => {
  /*
   * An approval is the gateway's own `Approval.Submit` procedure now, relayed
   * through /api/workflow/rpc: one call that records the decision AND resumes
   * the run it unblocked. The Worker no longer owns an approval shape, so it
   * cannot drift from the engine's.
   */
  test("/api/approvals/decision is the canonical unknown-route 404 now", async () => {
    const response = await worker.fetch(
      post("/api/approvals/decision", { runId: "run_01", nodeId: "approve", iteration: 0 }),
      assetsEnv()
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ status: "error", message: "Not found." })
  })
})

describe("the deleted recommendations seam", () => {
  test("every /api/reco/* route is the canonical unknown-route 404 now", async () => {
    for (const path of ["/api/reco/first-run", "/api/reco/feedback", "/api/reco/repos", "/api/reco/watched"]) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`), assetsEnv())
      expect(`${path} → ${response.status}`).toBe(`${path} → 404`)
      expect(await response.json()).toEqual({ status: "error", message: "Not found." })
    }
  })
})

describe("the admin surface (non-enumerable)", () => {
  const adminEnv = (): WorkerEnv => ({
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "service-token-123",
    IDENTITY_ADMIN_TOKEN: "identity-admin-123",
    BILLING_UPSTREAM_URL: "https://billing.test",
    BILLING_ADMIN_TOKEN: "billing-admin-123"
  })

  /** Identity double whose /validate answer is scriptable per test. */
  const identityDouble =
    (validate: Response, recorded?: Array<{ path: string; headers: Headers; body: unknown }>) =>
    (request: Request): Response | undefined => {
      const url = new URL(request.url)
      if (url.hostname !== "identity.test") return undefined
      if (url.pathname === "/api/identity/validate") return validate.clone()
      recorded?.push({ path: url.pathname, headers: request.headers, body: undefined })
      return new Response(JSON.stringify({ requests: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }

  const adminValidate = new Response(
    JSON.stringify({ login: "will", allowlisted: true, admin: true, scopes: [] }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
  const memberValidate = new Response(
    JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
  const noSession = new Response(JSON.stringify({ status: "error" }), { status: 401 })

  test("a signed-out probe gets byte-identical 404s for admin and unknown routes", async () => {
    await withMockedFetch(identityDouble(noSession), async () => {
      const unknown = await worker.fetch(new Request("https://mvp.test/api/definitely-not-a-route"), adminEnv())
      for (
        const path of [
          "/api/admin/allowlist",
          "/api/admin/grant",
          "/api/admin/requests",
          "/api/admin/feedback",
          "/api/admin/health"
        ]
      ) {
        const probe = await worker.fetch(new Request(`https://mvp.test${path}`), adminEnv())
        expect(probe.status).toBe(404)
        // Byte-identical: no enumeration signal in the body, status, or content type.
        expect(await probe.text()).toBe(await unknown.clone().text())
        expect(probe.headers.get("content-type")).toBe(unknown.headers.get("content-type"))
      }
      expect(unknown.status).toBe(404)
    })
  })

  test("a validated NON-admin session is equally undetectable", async () => {
    await withMockedFetch(identityDouble(memberValidate), async () => {
      const unknown = await worker.fetch(new Request("https://mvp.test/api/nope"), adminEnv())
      const probe = await worker.fetch(new Request("https://mvp.test/api/admin/requests"), adminEnv())
      expect(probe.status).toBe(404)
      expect(await probe.text()).toBe(await unknown.text())
    })
  })

  /*
   * Repro apps/ui/canary-repros/access/1.5: `admin` comes from identity's
   * ADMIN_LOGINS var, so removing a login from the closed-alpha allowlist left
   * the whole admin surface open to it — including POST /api/admin/allowlist,
   * the door that edits the allowlist itself. Identity now withholds the claim
   * from a non-allowlisted login; this Worker refuses on its own evidence too,
   * so one upstream field cannot re-open the surface on its own.
   */
  test("a de-allowlisted admin is as undetectable as a stranger", async () => {
    const deAllowlistedAdmin = new Response(
      JSON.stringify({ login: "will", allowlisted: false, admin: true, scopes: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
    await withMockedFetch(identityDouble(deAllowlistedAdmin), async () => {
      const unknown = await worker.fetch(new Request("https://mvp.test/api/nope"), adminEnv())
      const unknownBody = await unknown.text()
      for (
        const path of [
          "/api/admin/requests",
          "/api/admin/health",
          "/api/admin/feedback",
          "/api/admin/errors"
        ]
      ) {
        const probe = await worker.fetch(new Request(`https://mvp.test${path}`), adminEnv())
        expect(probe.status).toBe(404)
        expect(await probe.text()).toBe(unknownBody)
      }
      // The write door too: a revoked admin cannot re-add itself.
      const write = await worker.fetch(
        post("/api/admin/allowlist", { login: "will", action: "add" }),
        adminEnv()
      )
      expect(write.status).toBe(404)
      expect(await write.text()).toBe(unknownBody)
    })
  })

  test("admin allowlist writes carry the admin's login as requester and a fresh timestamp", async () => {
    let seen: { headers: Headers; body: unknown } | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : (input as Request)
      const url = new URL(request.url)
      if (url.hostname === "identity.test" && url.pathname === "/api/identity/validate") {
        return adminValidate.clone()
      }
      if (url.hostname === "identity.test" && url.pathname === "/api/identity/admin/allowlist") {
        seen = { headers: request.headers, body: await request.json() }
        return new Response(
          JSON.stringify({ applied: true, action: "add", login: "octocat", requester: "will" }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      }
      return originalFetch(request)
    }) as typeof fetch
    try {
      const response = await worker.fetch(
        post("/api/admin/allowlist", { login: "octocat", action: "add" }),
        adminEnv()
      )
      expect(response.status).toBe(201)
    } finally {
      globalThis.fetch = originalFetch
    }
    const body = seen?.body as { login: string; action: string; requester: string; timestamp: string }
    expect(seen?.headers.get("x-smithers-admin-token")).toBe("identity-admin-123")
    expect(body.login).toBe("octocat")
    expect(body.action).toBe("add")
    expect(body.requester).toBe("will")
    expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true)
  })

  test("admin grants forward to billing with attribution and a fresh admin: grant id", async () => {
    let seen: { headers: Headers; body: unknown } | undefined
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test") return adminValidate.clone()
        if (url.hostname === "billing.test" && url.pathname === "/api/billing/admin/grants") {
          return new Response("{}", { status: 201 })
        }
        return undefined
      },
      async () => {
        // Capture the grant body with a second pass that reads it.
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
          const request = typeof input === "string" ? new Request(input, init) : (input as Request)
          const url = new URL(request.url)
          if (url.hostname === "billing.test" && url.pathname === "/api/billing/admin/grants") {
            seen = { headers: request.headers, body: await request.json() }
            return new Response(JSON.stringify({ granted: true, grantId: "x" }), {
              status: 201,
              headers: { "content-type": "application/json" }
            })
          }
          return originalFetch(request)
        }) as typeof fetch
        try {
          const response = await worker.fetch(
            post("/api/admin/grant", { login: "octocat", amountUsd: 25 }),
            adminEnv()
          )
          expect(response.status).toBe(201)
        } finally {
          globalThis.fetch = originalFetch
        }
      }
    )
    expect(seen?.headers.get("x-smithers-admin-token")).toBe("billing-admin-123")
    const body = seen?.body as {
      userId: string
      grantId: string
      amountUsd: number
      kind: string
      requester: string
      timestamp: string
    }
    expect(body.userId).toBe("octocat")
    expect(body.amountUsd).toBe(25)
    expect(body.requester).toBe("will")
    expect(body.grantId).toMatch(/^admin:[A-Za-z0-9._:-]{3,190}$/)
    expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true)
  })

  test("admin reads proxy: the request queue", async () => {
    const seen: Array<{ host: string; path: string; token: string | null }> = []
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test" && url.pathname === "/api/identity/validate") {
          return adminValidate.clone()
        }
        if (url.hostname === "identity.test") {
          seen.push({ host: "identity", path: url.pathname, token: request.headers.get("x-smithers-admin-token") })
          return new Response(
            JSON.stringify({
              requests: [{
                login: "octocat",
                note: null,
                createdAt: "2026-08-08T00:00:00.000Z",
                updatedAt: "2026-08-08T00:00:00.000Z"
              }]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        }
        return undefined
      },
      async () => {
        const queue = await worker.fetch(new Request("https://mvp.test/api/admin/requests"), adminEnv())
        expect(queue.status).toBe(200)
        // The deleted recommendations admin surface is just another unknown route now.
        const feedback = await worker.fetch(new Request("https://mvp.test/api/admin/feedback"), adminEnv())
        expect(feedback.status).toBe(404)
      }
    )
    expect(seen.find((c) => c.host === "identity")?.path).toBe("/api/identity/admin/requests")
    expect(seen.find((c) => c.host === "identity")?.token).toBe("identity-admin-123")
  })

  test("admin.health composes real reads with an honest unconfigured line", async () => {
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test" && url.pathname === "/api/identity/validate") {
          return adminValidate.clone()
        }
        if (url.hostname === "identity.test" && url.pathname === "/healthz") {
          return new Response(JSON.stringify({ ok: true, admin: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        if (url.hostname === "identity.test" && url.pathname === "/api/identity/admin/requests") {
          return new Response(JSON.stringify({ requests: [{}, {}] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        if (url.hostname === "billing.test" && url.pathname === "/healthz") {
          return new Response(JSON.stringify({ ok: true, rateCardVersion: "2026-08-08" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        return undefined
      },
      async () => {
        const env: WorkerEnv = {
          ...assetsEnv(),
          IDENTITY_UPSTREAM_URL: "https://identity.test",
          IDENTITY_SERVICE_TOKEN: "service-token-123",
          IDENTITY_ADMIN_TOKEN: "identity-admin-123",
          BILLING_UPSTREAM_URL: "https://billing.test",
          BILLING_ADMIN_TOKEN: "billing-admin-123"
        }
        const response = await worker.fetch(new Request("https://mvp.test/api/admin/health"), env)
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          services: Array<{ name: string; status: string }>
          queueDepth: number | null
          charges: unknown
        }
        expect(body.services.map((s) => `${s.name}:${s.status}`)).toEqual([
          "billing:ok",
          "identity:ok"
        ])
        expect(body.queueDepth).toBe(2)
        // No BILLING_AUTH_TOKEN in this env: charges is honestly absent, not zero.
        expect(body.charges).toBeNull()
      }
    )
  })

  test("an admin route without its admin token 501s honestly (never a silent forward)", async () => {
    await withMockedFetch(identityDouble(adminValidate), async () => {
      const env: WorkerEnv = {
        ...assetsEnv(),
        IDENTITY_UPSTREAM_URL: "https://identity.test",
        IDENTITY_SERVICE_TOKEN: "service-token-123"
      }
      const response = await worker.fetch(new Request("https://mvp.test/api/admin/requests"), env)
      expect(response.status).toBe(501)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("IDENTITY_ADMIN_TOKEN")
    })
  })
})

describe("the tool-loop forwarding", () => {
  test("the turn's tools reach the chat upstream untouched", async () => {
    let seenBody: unknown
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const tools = [
      {
        type: "function",
        name: "commands",
        description: "the one tool",
        parameters: { type: "object", properties: {} }
      }
    ]
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return new Response("{}", { status: 200 })
      },
      async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
          const request = typeof input === "string" ? new Request(input, init) : (input as Request)
          if (new URL(request.url).hostname === "upstream.test") {
            seenBody = await request.json()
            return ndjsonUpstream([{ type: "done", reason: "stop" }])
          }
          return originalFetch(request)
        }) as typeof fetch
        try {
          const response = await worker.fetch(
            post("/api/agent/turn", { ...turnBody, runId: "run-tools", tools }),
            env
          )
          expect(response.status).toBe(200)
          // Drain the stream so the turn's cancel handle releases for later tests.
          await response.text()
        } finally {
          globalThis.fetch = originalFetch
        }
      }
    )
    expect(seenBody).toEqual({
      messages: turnBody.messages,
      instructions: turnBody.instructions,
      tools
    })
  })

  test("tool continuation messages (function_call / function_call_output) pass validation", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          post("/api/agent/turn", {
            ...turnBody,
            runId: "run-tool-items",
            messages: [
              { role: "user", content: "make a note" },
              { type: "function_call", call_id: "c1", name: "commands", arguments: "{}" },
              { type: "function_call_output", call_id: "c1", output: "executed /world.new-note" }
            ]
          }),
          env
        )
        expect(response.status).toBe(200)
        await response.text()
      }
    )
  })
})

/*
 * Wave 6c (launch checklist B-3): the server-side kill. workerd forbids
 * touching another request's AbortController, so the kill state lives in the
 * TurnCancelRegistry Durable Object; the cancel route flips it and the
 * streaming turn handler observes it between chunks. These tests run the
 * registry against in-memory storage and the routes against a memory
 * namespace implementing the same binding surface.
 */
const memoryStorage = (seed?: Record<string, unknown>): TurnCancelStorage => {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}))
  return {
    get: async (key) => data.get(key) as never,
    put: async (key, value) => void data.set(key, value)
  }
}

const memoryCancels = (): TurnCancelNamespace & { generations: Map<string, string> } => {
  const generations = new Map<string, string>()
  const registries = new Map<string, TurnCancelRegistry>()
  return {
    generations,
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let registry = registries.get(name)
      if (registry === undefined) {
        registry = new TurnCancelRegistry({ storage: memoryStorage() })
        registries.set(name, registry)
      }
      return { fetch: async (request) => {
        const response = await registry.fetch(request)
        if (new URL(request.url).pathname === "/register") {
          const body = await response.clone().json() as { generation?: string }
          if (body.generation !== undefined) generations.set(name, body.generation)
        }
        return response
      } }
    }
  }
}

const registryGenerations = new WeakMap<TurnCancelRegistry, string>()
const doPost = async (registry: TurnCancelRegistry, path: string, owner?: string): Promise<Response> => {
  const headers = new Headers(owner === undefined ? {} : { "x-turn-owner": owner })
  const generation = registryGenerations.get(registry)
  if (generation !== undefined) headers.set("x-turn-generation", generation)
  const response = await registry.fetch(new Request(`https://turn-cancel.internal${path}`, { method: "POST", headers }))
  if (path === "/register") {
    const body = await response.clone().json() as { generation?: string }
    if (body.generation !== undefined) registryGenerations.set(registry, body.generation)
  }
  return response
}

describe("the turn-cancel registry (Durable Object state)", () => {
  test("register starts a turn, a duplicate register is refused, cancel kills it", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "already-running" })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "cancelled" })
    // The kill is terminal: a second cancel, and the state read, agree.
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    expect(await (await doPost(registry, "/state")).json()).toEqual({
      state: "cancelled"
    })
  })

  test("a settled turn answers cancel with an honest not-found and may re-register", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    await doPost(registry, "/register")
    await doPost(registry, "/settle")
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    // Tool-loop legs reuse the runId: a settled turn registers again.
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
  })

  test("cancel on a never-registered run is not-found", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
  })

  test("a stale active registration no longer holds the runId hostage", async () => {
    const stale = Date.now() - 11 * 60 * 1000
    const registry = new TurnCancelRegistry({
      storage: memoryStorage({ state: { state: "active", at: stale } })
    })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
  })

  test("only the registering owner may cancel an owned registration", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    const as = (login: string, path: string): Promise<Response> => doPost(registry, path, login)
    expect(await (await as("alice", "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
    // A different login — and an anonymous caller — cannot kill alice's turn.
    expect(await (await as("bob", "/cancel")).json()).toEqual({ status: "forbidden" })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "forbidden" })
    // The run is untouched, and its owner can still kill it.
    expect(await (await as("alice", "/cancel")).json()).toEqual({ status: "cancelled" })
  })

  test("an owned active registration refuses a squatting re-register from anyone", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    const registerAs = (login: string): Promise<Response> =>
      registry.fetch(
        new Request("https://turn-cancel.internal/register", {
          method: "POST",
          headers: { "x-turn-owner": login }
        })
      )
    expect(await (await registerAs("alice")).json()).toEqual({ status: "started", generation: expect.any(String) })
    expect(await (await registerAs("bob")).json()).toEqual({ status: "already-running" })
    expect(await (await registerAs("alice")).json()).toEqual({ status: "already-running" })
  })
})

describe("the server-side kill route (B-3)", () => {
  /** An upstream that emits one delta and then streams nothing until cancelled. */
  const hangingUpstream = (): { response: () => Response; wasCancelled: () => boolean } => {
    let cancelled = false
    return {
      wasCancelled: () => cancelled,
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ type: "delta", kind: "text", text: "working" })}\n`
                )
              )
            },
            cancel: () => {
              cancelled = true
            }
          }),
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
    }
  }

  const kill = (runId: string, env: WorkerEnv): Promise<Response> =>
    worker.fetch(post("/api/agent/turn/cancel", { runId }), env)

  test("a mid-stream kill ends the turn with an honest cancelled frame, then not-found", async () => {
    const upstream = hangingUpstream()
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: memoryCancels()
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return upstream.response()
      },
      async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-kill" }), env)
        expect(turn.status).toBe(200)
        const reader = turn.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        const nextFrame = async (): Promise<Record<string, unknown>> => {
          for (;;) {
            const line = buffer.split("\n")[0]
            if (buffer.includes("\n")) {
              buffer = buffer.slice(buffer.indexOf("\n") + 1)
              if (line.trim() !== "") return JSON.parse(line) as Record<string, unknown>
              continue
            }
            const { value, done } = await reader.read()
            if (done) throw new Error("stream ended before the next frame")
            buffer += decoder.decode(value, { stream: true })
          }
        }
        const first = await nextFrame()
        expect(first).toEqual({ runId: "run-kill", type: "delta", kind: "text", text: "working" })

        // The kill lands mid-flight: never a 500, always the honest status.
        const cancelled = await kill("run-kill", env)
        expect(cancelled.status).toBe(200)
        expect(await cancelled.json()).toEqual({ status: "cancelled" })

        // The turn's own pump observes the kill between chunks (here: on the
        // poll tick, the upstream being silent), aborts its upstream fetch,
        // and closes with the honest terminal frame — never a silent stop.
        const terminal = await nextFrame()
        expect(terminal).toEqual({ runId: "run-kill", type: "done", reason: "cancelled" })
        expect((await reader.read()).done).toBe(true)
        expect(upstream.wasCancelled()).toBe(true)

        // The turn settled: killing it again is an honest not-found, and the
        // runId is free to register again (tool-loop discipline).
        const again = await kill("run-kill", env)
        expect(again.status).toBe(200)
        expect(await again.json()).toEqual({ status: "not-found" })
      }
    )
  })

  test("killing a turn that already completed is not-found, never an error", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: memoryCancels()
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return ndjsonUpstream([
          { type: "delta", kind: "text", text: "done already" },
          { type: "done", reason: "stop" }
        ])
      },
      async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-settled" }), env)
        expect(turn.status).toBe(200)
        await turn.text()
        const late = await kill("run-settled", env)
        expect(late.status).toBe(200)
        expect(await late.json()).toEqual({ status: "not-found" })
      }
    )
  })

  /*
   * Owner scoping: any allowlisted login may hold a runId (they arrive in
   * client logs, URLs, bug reports), so the kill must check WHO asks, not
   * just WHICH run. The registry records the validated login at register
   * time and refuses everyone else; the in-isolate fallback does the same.
   */
  const signedPost = (path: string, body: unknown, login: string): Request =>
    new Request(`https://mvp.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `smithers_session=${login}` },
      body: JSON.stringify(body)
    })

  const ownerScopedEnv = (cancels: boolean): WorkerEnv => ({
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    SMITHERS_CHAT_URL: "https://upstream.test/chat",
    ...(cancels ? { TURN_CANCELS: memoryCancels() } : {})
  })

  const withSessions = async (
    upstream: ReturnType<typeof hangingUpstream>,
    run: () => Promise<void>
  ): Promise<void> =>
    withMockedFetch(
      (request) => {
        const host = new URL(request.url).hostname
        if (host === "identity.test") {
          const login = request.headers.get("cookie")?.includes("smithers_session=bob") ? "bob" : "alice"
          return new Response(JSON.stringify({ login, allowlisted: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        if (host === "upstream.test") return upstream.response()
        return undefined
      },
      run
    )

  test("only the turn's owner may kill it, through the registry", async () => {
    const upstream = hangingUpstream()
    const env = ownerScopedEnv(true)
    await withSessions(upstream, async () => {
      const turn = await worker.fetch(
        signedPost("/api/agent/turn", { ...turnBody, runId: "run-owned" }, "alice"),
        env
      )
      expect(turn.status).toBe(200)
      // Bob is signed in and allowlisted and knows the runId — not his turn.
      const stranger = await worker.fetch(
        signedPost("/api/agent/turn/cancel", { runId: "run-owned" }, "bob"),
        env
      )
      expect(stranger.status).toBe(403)
      const mine = await worker.fetch(
        signedPost("/api/agent/turn/cancel", { runId: "run-owned" }, "alice"),
        env
      )
      expect(mine.status).toBe(200)
      expect(await mine.json()).toEqual({ status: "cancelled" })
      await turn.body?.cancel()
    })
  })

  test("only the turn's owner may kill it, through the in-isolate fallback", async () => {
    const upstream = hangingUpstream()
    const env = ownerScopedEnv(false)
    await withSessions(upstream, async () => {
      const turn = await worker.fetch(
        signedPost("/api/agent/turn", { ...turnBody, runId: "run-local" }, "alice"),
        env
      )
      expect(turn.status).toBe(200)
      const stranger = await worker.fetch(
        signedPost("/api/agent/turn/cancel", { runId: "run-local" }, "bob"),
        env
      )
      expect(stranger.status).toBe(403)
      const mine = await worker.fetch(
        signedPost("/api/agent/turn/cancel", { runId: "run-local" }, "alice"),
        env
      )
      expect(mine.status).toBe(200)
      expect(await mine.json()).toEqual({ status: "cancelled" })
      await turn.body?.cancel()
    })
  })

  test("a long stream does not spend one Durable Object subrequest per chunk", async () => {
    // A Worker request may make ~1000 subrequests, and every kill check is
    // one: a token-streamed turn delivers far more chunks than that, so an
    // unthrottled per-chunk poll would end long turns with "Too many
    // subrequests". The poll is rate-limited instead.
    const namespace = memoryCancels()
    let stateReads = 0
    const counted: TurnCancelNamespace = {
      idFromName: (name) => namespace.idFromName(name),
      get: (id) => {
        const stub = namespace.get(id)
        return {
          fetch: (request) => {
            if (new URL(request.url).pathname === "/state") stateReads += 1
            return stub.fetch(request)
          }
        }
      }
    }
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: counted
    }
    const chunks = 400
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return ndjsonUpstream([
          ...Array.from({ length: chunks }, (_, index) => ({
            type: "delta",
            kind: "text",
            text: `t${index}`
          })),
          { type: "done", reason: "stop" }
        ])
      },
      async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-long" }), env)
        expect(turn.status).toBe(200)
        const body = await turn.text()
        expect(body.trim().split("\n")).toHaveLength(chunks + 1)
        // One poll per CANCEL_POLL_CHUNKS (64) chunks, not one per chunk.
        expect(stateReads).toBeGreaterThan(0)
        expect(stateReads).toBeLessThan(chunks / 8)
      }
    )
  })

  test("the kill route with the registry bound never 500s on an unknown run", async () => {
    const env: WorkerEnv = { ...assetsEnv(), TURN_CANCELS: memoryCancels() }
    const response = await kill("ghost", env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "not-found" })
  })

  test("a duplicate turn registration 409s through the registry", async () => {
    const upstream = hangingUpstream()
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: memoryCancels()
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return upstream.response()
      },
      async () => {
        const first = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-dupe" }), env)
        expect(first.status).toBe(200)
        const second = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-dupe" }), env)
        expect(second.status).toBe(409)
        // Clean up: kill the hanging turn and drain it.
        await kill("run-dupe", env)
        await first.text()
      }
    )
  })
})

describe("the browser tool route (§2d)", () => {
  test("without a pinned egress binding the capability is absent and reads fail closed without DNS", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error("unexpected outbound fetch") }) as unknown as typeof fetch
    try {
      const bootstrap = await worker.fetch(new Request("https://mvp.test/api/bootstrap"), assetsEnv())
      expect(AppBootstrapSchema.parse(await bootstrap.json()).capabilities).not.toContain("browser.read")
      const response = await worker.fetch(post("/api/tools/browser-fetch", { url: "https://example.com/" }), assetsEnv())
      expect(response.status).toBe(501)
    } finally { globalThis.fetch = original }
  })

  test("a configured binding receives the validated address and revalidates every redirect without caller credentials", async () => {
    const calls: Array<Record<string, unknown>> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input))
      expect(url.hostname).toBe("cloudflare-dns.com")
      const name = url.searchParams.get("name")
      return Response.json({ Answer: url.searchParams.get("type") === "A"
        ? [{ type: 1, data: name === "next.test" ? "8.8.4.4" : "8.8.8.8" }]
        : [] })
    }) as typeof fetch
    const env: WorkerEnv = { ...assetsEnv(), BROWSER_EGRESS: { fetch: async (request) => {
      expect(request.url).toBe("https://browser-egress.internal/fetch")
      expect(request.redirect).toBe("manual")
      expect(request.headers.has("authorization")).toBe(false)
      expect(request.headers.has("cookie")).toBe(false)
      calls.push(await request.json() as Record<string, unknown>)
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://next.test/page" } })
        : new Response("<p>Read securely</p>", { headers: { "content-type": "text/html" } })
    } } }
    try {
      const bootstrap = await worker.fetch(new Request("https://mvp.test/api/bootstrap"), env)
      expect(AppBootstrapSchema.parse(await bootstrap.json()).capabilities).toContain("browser.read")
      const request = post("/api/tools/browser-fetch", { url: "https://first.test/" })
      request.headers.set("authorization", "Bearer never-forward-this")
      request.headers.set("cookie", "never=forward-this")
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ finalUrl: "https://next.test/page", text: "Read securely" })
      expect(calls.map(({ address, url, version }) => ({ address, url, version }))).toEqual([
        { address: "8.8.8.8", url: "https://first.test/", version: 1 },
        { address: "8.8.4.4", url: "https://next.test/page", version: 1 }
      ])
      expect(JSON.stringify(calls)).not.toContain("never-forward-this")
      expect(JSON.stringify(calls)).not.toContain("never=forward-this")
    } finally { globalThis.fetch = original }
  })

  test("a pinned-egress redirect to a private host is refused before a second binding call", async () => {
    let calls = 0
    const env: WorkerEnv = { ...assetsEnv(), BROWSER_EGRESS: { fetch: async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } })
    } } }
    const response = await worker.fetch(post("/api/tools/browser-fetch", { url: "https://8.8.8.8/" }), env)
    expect(response.status).toBe(422)
    expect(calls).toBe(1)
  })

  test("a malformed body is a 400, a non-https URL a guarded 422 — no fetch happens", async () => {
    const bad = await worker.fetch(post("/api/tools/browser-fetch", { nope: true }), assetsEnv())
    expect(bad.status).toBe(400)
    const env: WorkerEnv = { ...assetsEnv(), BROWSER_EGRESS: { fetch: async () => { throw new Error("must not fetch") } } }
    const http = await worker.fetch(post("/api/tools/browser-fetch", { url: "http://example.com/" }), env)
    expect(http.status).toBe(422)
    expect(((await http.json()) as { message: string }).message).toContain("https")
    const privateIp = await worker.fetch(
      post("/api/tools/browser-fetch", { url: "https://127.0.0.1/" }),
      env
    )
    expect(privateIp.status).toBe(422)
    const internal = await worker.fetch(
      post("/api/tools/browser-fetch", { url: "https://db.internal/" }),
      env
    )
    expect(internal.status).toBe(422)
  })

  test("with an identity seam configured, an anonymous caller gets the session gate's 401", async () => {
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    const original = globalThis.fetch
    globalThis.fetch =
      (async () => new Response(JSON.stringify({ status: "error" }), { status: 401 })) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/tools/browser-fetch", { url: "https://example.com/" }), env)
      expect(response.status).toBe(401)
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * The native sign-in handoff's callback answers a 200 HTML success page
   * (the session travels via the claim endpoint, not the tab). The Wave-8
   * no-dead-ends wrapper must pass that page through — live, it replaced it
   * with a 502 "nothing was signed in" surface for a user who WAS signed in.
   */
  test("a 200 HTML answer from the OAuth callback passes through as the success page it is", async () => {
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    const original = globalThis.fetch
    globalThis.fetch =
      (async () =>
        new Response("<!doctype html><title>Signed in</title>You're signed in — return to the Smithers app.", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/auth/github/callback?code=x&state=y", {
          headers: { accept: "text/html" }
        }),
        env
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("return to the Smithers app")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * The curated platform proxy (MULTI-ACTIONS-GAP.md): allowlisted paths are
   * CLAIMED by the worker even when the deployment cannot serve them — the
   * honest 503, never the canonical 404 — and anything off the allowlist
   * stays the canonical 404.
   */
  test("account and write proxy paths answer the honest no-identity 503, never the canonical 404", async () => {
    const paths: ReadonlyArray<readonly [string, string]> = [
      ["POST", "/api/repos/will/flows/issues"],
      ["POST", "/api/github/import"],
      ["GET", "/api/user/repos"],
      ["GET", "/api/user/workspaces?limit=100"],
      ["GET", "/api/user/orgs"],
      ["GET", "/api/orgs/smithersai/provider-connections"],
      ["POST", "/api/orgs/smithersai/changesets/7/land"],
      ["GET", "/api/integrations/linear"],
      ["DELETE", "/api/integrations/linear/7"],
      ["POST", "/api/linear"],
      ["POST", "/api/linear/7/ops/9/retry"],
      ["GET", "/api/notifications/list"],
      ["POST", "/api/billing/checkout"],
      ["POST", "/api/billing/portal"]
    ]
    for (const [method, path] of paths) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`, { method }), assetsEnv())
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 503`)
    }
  })

  test("methods outside the platform-proxy allowlist stay the canonical 404", async () => {
    // GET /api/billing/checkout is NOT here: off the proxy allowlist it falls
    // through to the /api/billing/ prefix, which the product billing worker owns.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["DELETE", "/api/notifications/list"],
      ["POST", "/api/user/repos"],
      /* The BYOK key family was deleted with keys.list / keys.remove: nothing forwards, nothing answers 501. */
      ["GET", "/api/user/byok-keys"],
      ["DELETE", "/api/user/byok-keys/anthropic"],
      ["PATCH", "/api/user/workspaces"],
      ["PUT", "/api/orgs/smithersai/provider-connections"],
      ["PUT", "/api/linear/7"],
      /*
       * Doors no product seam calls (apps/ui/src/mainview/state/seams): a PAT
       * mint, a provider-connection write, an org delete, an integration
       * create or patch, a Linear delete. The bridge hands the page whatever
       * the platform answers, so a row here is a capability, and every row
       * lands in the same commit as the seam that needs it (parity-hosts (b)).
       */
      ["GET", "/api/user/provider-connections"],
      ["POST", "/api/user/provider-connections"],
      ["GET", "/api/user/tokens"],
      ["POST", "/api/user/tokens"],
      ["DELETE", "/api/user/tokens/7"],
      ["DELETE", "/api/orgs/smithersai"],
      ["POST", "/api/integrations/linear"],
      ["PATCH", "/api/integrations/linear/7"],
      ["DELETE", "/api/linear/7"]
    ]
    for (const [method, path] of cases) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`, { method }), assetsEnv())
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`)
    }
  })

  /*
   * Repro apps/ui/canary-repros/admin/28.5 and cards/8.21: the proxy forwarded
   * every allowlisted path, and the Smithers Cloud Go router's plain-text
   * `404 page not found` came back through it and was rendered verbatim into
   * the user's toast. A body written for a router is never a message for a
   * reader.
   */
  test("a platform failure is restated in the seam's envelope, never forwarded raw", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      if (url.includes("/api/identity/cloud-token")) {
        return new Response(JSON.stringify({ found: true, token: "cloud-token-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      return new Response("404 page not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      })
    }) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/repos/will/flows/issues?state=open"),
        env
      )
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = (await response.json()) as { status: string; message: string }
      expect(body.status).toBe("error")
      expect(body.message).not.toContain("404 page not found")
      expect(body.message).toContain("Smithers Cloud")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * Repro apps/ui/canary-repros/money/17.4: `/billing.upgrade` on an MVP
   * account fired a live POST /api/billing/checkout and came back the
   * platform's `stripe billing is not configured`. The alpha comps every
   * balance, so the honest answer is that there is nothing to buy — and the
   * request never reaches Stripe.
   */
  test("checkout and the billing portal are refused while the alpha comps every balance", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    const seen: Array<string> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      seen.push(url)
      if (url.includes("/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      return new Response(JSON.stringify({ message: "stripe billing is not configured" }), { status: 400 })
    }) as unknown as typeof fetch
    try {
      for (const path of ["/api/billing/checkout", "/api/billing/portal"]) {
        const response = await worker.fetch(new Request(`https://mvp.test${path}`, { method: "POST" }), env)
        expect(`${path} → ${response.status}`).toBe(`${path} → 501`)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("nothing to buy")
        expect(body.message).not.toContain("stripe")
      }
      expect(seen.some((url) => url.includes("cloud.test"))).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })

  test("a deployment that has shipped paid plans forwards checkout unchanged", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test",
      BILLING_CHECKOUT_ENABLED: "1"
    }
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      if (url.includes("/api/identity/cloud-token")) {
        return new Response(JSON.stringify({ found: true, token: "cloud-token-1" }), { status: 200 })
      }
      return new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/billing/checkout", { method: "POST" }),
        env
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/session" })
    } finally {
      globalThis.fetch = original
    }
  })

  test("the platform proxy forwards with the user's cloud bearer and passes the platform answer through", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    const seen: Array<{ url: string; auth: string | null; method: string }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("https://identity.test/api/identity/validate")) {
        return new Response(
          JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url.startsWith("https://identity.test/api/identity/cloud-token")) {
        return new Response(JSON.stringify({ found: true, token: "cloud-token-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      const auth = new Headers(init?.headers).get("authorization")
      seen.push({ url, auth, method: init?.method ?? "GET" })
      return new Response(JSON.stringify([{ number: 7, title: "A bug", state: "open" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/repos/will/flows/issues?state=open", { headers: { cookie: "smithers_session=sealed" } }),
        env
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ number: 7, title: "A bug", state: "open" }])
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toBe("https://cloud.test/api/repos/will/flows/issues?state=open")
      expect(seen[0]?.auth).toBe("Bearer cloud-token-1")
    } finally {
      globalThis.fetch = original
    }
  })
})

/*
 * The `/api/cloud/<inner>` bridge (apps/ui/docs/web-mode/PLAN.md §0 correction
 * 4, lane W0). Seven product seams call `CLOUD_ROUTE_PREFIX + path`, which the
 * Bun origin proxies with the Smithers Cloud PAT and this Worker answered with the
 * canonical 404, so on the web the repository list never loaded. The Worker
 * strips the prefix and hands the inner path to the SAME allowlist and the
 * SAME cookie-to-cloud-token bridge as the direct platform proxy; anything
 * that is not a single absolute path is refused before a token is spent.
 */
describe("the /api/cloud bridge", () => {
  const signedInEnv: WorkerEnv = {
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "svc",
    SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
  }
  interface UpstreamCall {
    readonly url: string
    readonly method: string
    readonly headers: Headers
    readonly body: RequestInit["body"]
  }
  /**
   * Identity validates the session and mints `cloud-token-1`; every other
   * fetch is recorded (identity calls included, so an empty log proves the
   * Worker refused before the gate) and answered with `answer()`.
   */
  const withUpstreams = async <T>(
    answer: () => Response,
    run: (calls: Array<UpstreamCall>) => Promise<T>
  ): Promise<T> => {
    const calls: Array<UpstreamCall> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body })
      if (url.startsWith("https://identity.test/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      if (url.startsWith("https://identity.test/api/identity/cloud-token")) {
        return new Response(JSON.stringify({ found: true, token: "cloud-token-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      return answer()
    }) as unknown as typeof fetch
    try {
      return await run(calls)
    } finally {
      globalThis.fetch = original
    }
  }
  const cloudCalls = (calls: ReadonlyArray<UpstreamCall>): Array<UpstreamCall> =>
    calls.filter((call) => call.url.startsWith("https://cloud.test"))
  const jsonAnswer = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

  test("wiki CRDT updates carry the full 1 MiB binary envelope through direct and cloud routes", async () => {
    const body = JSON.stringify({
      page_id: 42, update_id: "6481dbcb-879f-4db7-b2d5-d8868e325e36", update: btoa("\0".repeat(1024 * 1024))
    })
    for (const prefix of ["", "/api/cloud"]) {
      await withUpstreams(() => jsonAnswer({ accepted_revision: 12 }), async (calls) => {
        const response = await worker.fetch(new Request(`https://mvp.test${prefix}/api/repos/will/flows/wiki/intent/updates`, {
          method: "POST", headers: { cookie: "smithers_session=sealed", "content-type": "application/json" }, body
        }), signedInEnv)
        expect(response.status).toBe(200)
        const forwarded = cloudCalls(calls)
        expect(forwarded).toHaveLength(1)
        expect(await new Response(forwarded[0]?.body).text()).toBe(body)
      })
    }
  })

  test("the larger wiki allowance does not extend to other mutations or lookalike routes", async () => {
    for (const [method, path] of [
      ["POST", "/api/repos/will/flows/issues"],
      ["PATCH", "/api/repos/will/flows/wiki/intent"],
      ["PATCH", "/api/repos/will/flows/wiki/intent/updates"],
      ["POST", "/api/repos/will/flows/wiki/intent/updates/extra"],
      ["POST", "/api/repos/will/flows/wiki/intent/updates%2fextra"],
      ["POST", "/api/repos/will/flows/wiki/intent%2fother/updates"]
    ]) {
      await withUpstreams(() => jsonAnswer({}), async (calls) => {
        const response = await worker.fetch(new Request(`https://mvp.test/api/cloud${path}`, {
          method, headers: { cookie: "smithers_session=sealed" }, body: "x".repeat(256 * 1024 + 1)
        }), signedInEnv)
        expect(response.status).toBe(413)
        expect(cloudCalls(calls)).toHaveLength(0)
      })
    }
  })

  test("wiki envelopes enforce declared and streamed byte caps before forwarding", async () => {
    const limit = 2 * 1024 * 1024
    await withUpstreams(() => jsonAnswer({}), async (calls) => {
      const declared = await worker.fetch(new Request("https://mvp.test/api/repos/will/flows/wiki/intent/updates", {
        method: "POST", headers: { cookie: "smithers_session=sealed", "content-length": String(limit + 1) }, body: "{}"
      }), signedInEnv)
      expect(declared.status).toBe(413)
      let pulled = 0, cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(256 * 1024)) },
        cancel() { cancelled = true }
      }, { highWaterMark: 0 })
      const streamed = await worker.fetch(new Request("https://mvp.test/api/cloud/api/repos/will/flows/wiki/intent/updates", {
        method: "POST", headers: { cookie: "smithers_session=sealed" }, body: stream
      }), signedInEnv)
      expect(streamed.status).toBe(413)
      expect(cancelled).toBe(true)
      expect(pulled).toBe(9)
      expect(cloudCalls(calls)).toHaveLength(0)
    })
  })

  test("the 256 KiB cap refuses a declared length before reading and cancels a chunked body at the cap", async () => {
    await withUpstreams(() => jsonAnswer({}), async (calls) => {
      const declared = await worker.fetch(new Request("https://mvp.test/api/repos/will/flows/contents/file", {
        method: "PUT", headers: { cookie: "smithers_session=sealed", "content-length": String(8 * 1024 * 1024) }, body: "{}"
      }), signedInEnv)
      expect(declared.status).toBe(413)
      let pulled = 0, cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024)) },
        cancel() { cancelled = true }
      }, { highWaterMark: 0 })
      const streamed = await worker.fetch(new Request("https://mvp.test/api/cloud/api/repos/will/flows/contents/file", {
        method: "PUT", headers: { cookie: "smithers_session=sealed" }, body: stream
      }), signedInEnv)
      expect(streamed.status).toBe(413)
      // 4 chunks fill the cap exactly; the 5th crosses it and cancels — an
      // 8 MiB body is never buffered the way request.arrayBuffer() buffered it.
      expect(cancelled).toBe(true)
      expect(pulled).toBe(5)
      expect(cloudCalls(calls)).toHaveLength(0)
    })
  })

  test("/api/cloud/api/user/repos bridges with the user's cloud bearer and the inner path arrives without the prefix", async () => {
    await withUpstreams(() => jsonAnswer([{ full_name: "will/smithers" }]), async (calls) => {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/cloud/api/user/repos?per_page=1", {
          headers: {
            cookie: "smithers_session=sealed",
            // A client-supplied bearer is a forgery: the bridge mints its own.
            authorization: "Bearer renderer_forgery",
            [LOCAL_SESSION_HEADER]: "local-token"
          }
        }),
        signedInEnv
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ full_name: "will/smithers" }])
      const cloud = cloudCalls(calls)
      expect(cloud).toHaveLength(1)
      expect(cloud[0]?.url).toBe("https://cloud.test/api/user/repos?per_page=1")
      expect(cloud[0]?.method).toBe("GET")
      expect(cloud[0]?.headers.get("authorization")).toBe("Bearer cloud-token-1")
      expect(cloud[0]?.headers.get("cookie")).toBeNull()
      expect(cloud[0]?.headers.get(LOCAL_SESSION_HEADER)).toBeNull()
    })
  })

  test("every allowlisted family answers the same through the bridge as through the direct route", async () => {
    // The table is exported for the parity matrix (PLAN.md §6); walking it
    // here proves the bridge reuses the direct proxy instead of forking it:
    // same status, same body, same upstream URL, for every row and method.
    for (const rule of PLATFORM_PROXY_RULES) {
      const inner = rule.exact ?? `${rule.prefix}x`
      for (const method of rule.methods) {
        await withUpstreams(() => jsonAnswer({ ok: true }), async (calls) => {
          const direct = await worker.fetch(new Request(`https://mvp.test${inner}`, { method }), signedInEnv)
          const bridged = await worker.fetch(
            new Request(`https://mvp.test${CLOUD_ROUTE_PREFIX}${inner.slice(1)}`, { method }),
            signedInEnv
          )
          expect(`${method} ${inner} → ${bridged.status}`).toBe(`${method} ${inner} → ${direct.status}`)
          expect(await bridged.json()).toEqual(await direct.json())
          const cloud = cloudCalls(calls)
          if (cloud.length > 0) {
            expect(cloud).toHaveLength(2)
            expect(cloud[1]?.url).toBe(cloud[0]?.url)
          }
        })
      }
    }
  })

  test("/api/cloud/api/admin/x and any inner path outside the allowlist answer the canonical 404 before any upstream call", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/api/cloud/api/admin/x"],
      ["GET", "/api/cloud/api/admin/allowlist"],
      ["POST", "/api/cloud/api/agent/turn"],
      ["GET", "/api/cloud/api/identity/validate"],
      /* The method is part of the rule. */
      ["POST", "/api/cloud/api/user/repos"],
      ["GET", "/api/cloud/api/billing/checkout"],
      /* One character short of the prefix. */
      ["GET", "/api/cloud/api/user/repo"],
      /* An empty inner path. */
      ["GET", "/api/cloud/"]
    ]
    await withUpstreams(() => jsonAnswer({}), async (calls) => {
      for (const [method, path] of cases) {
        const response = await worker.fetch(new Request(`https://mvp.test${path}`, { method }), signedInEnv)
        expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`)
        expect(await response.json()).toEqual({ status: "error", message: "Not found." })
      }
      expect(calls).toEqual([])
    })
  })

  test("a scheme-relative, dot-segment, or absolute-URL inner path answers 404 and never reaches an upstream", async () => {
    const attacks = [
      /* Sliced naively this is scheme-relative: the bearer would go to evil.example. */
      "/api/cloud//evil.example/api/user/repos",
      "/api/cloud//evil.example/x",
      /* Dot segments that would walk an allowlisted prefix onto the admin surface. */
      "/api/cloud/api/repos/../../admin/x",
      "/api/cloud/api/repos/%2e%2e/%2e%2e/admin/x",
      "/api/cloud/api/user/repos/%2E%2E/%2E%2E/admin/x",
      /* An absolute URL, plain and encoded, and an encoded backslash pair. */
      "/api/cloud/https://evil.example/api/user/repos",
      "/api/cloud/https:%2F%2Fevil.example/api/user/repos",
      "/api/cloud/%5C%5Cevil.example/api/user/repos"
    ]
    await withUpstreams(() => jsonAnswer({}), async (calls) => {
      for (const path of attacks) {
        const response = await worker.fetch(new Request(`https://mvp.test${path}`), signedInEnv)
        expect(`${path} → ${response.status}`).toBe(`${path} → 404`)
        expect(await response.json()).toEqual({ status: "error", message: "Not found." })
      }
      expect(calls).toEqual([])
    })
  })

  test("without an identity seam the bridge answers the platform proxy's honest 503, not a 404", async () => {
    const direct = await worker.fetch(new Request("https://mvp.test/api/user/repos"), assetsEnv())
    const bridged = await worker.fetch(new Request("https://mvp.test/api/cloud/api/user/repos"), assetsEnv())
    expect(direct.status).toBe(503)
    expect(bridged.status).toBe(503)
    expect(await bridged.json()).toEqual(await direct.json())
  })

  test("bootstrap capabilities are cloudCapabilities(...) for every env shape, and the Worker claims no cloud door yet", async () => {
    const agentShapes: ReadonlyArray<readonly [Partial<WorkerEnv>, boolean]> = [
      [{}, false],
      [{ SMITHERS_CHAT_AUTH_TOKEN: "chat" }, true],
      [{ CHAT_PRODUCT_SERVICE_TOKEN: "svc" }, true],
      [{ SMITHERS_CHAT_AUTH_TOKEN: " " }, false]
    ]
    for (const identity of [false, true]) {
      for (const cloud of [false, true]) {
        for (const [agentEnv, agent] of agentShapes) {
          for (const checkout of ["1", "0", undefined]) {
            const env: WorkerEnv = {
              ...assetsEnv(),
              ...agentEnv,
              ...(identity ? { IDENTITY_UPSTREAM_URL: "https://identity.test" } : {}),
              ...(cloud ? { SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" } : {}),
              ...(checkout === undefined ? {} : { BILLING_CHECKOUT_ENABLED: checkout })
            }
            const response = await worker.fetch(new Request("https://mvp.test/api/bootstrap"), env)
            const body = AppBootstrapSchema.parse(await response.json())
            expect(body.capabilities).toEqual(
              cloudCapabilities({ identity, cloud, agent, checkout: checkout === "1", terminal: false })
            )
            expect(body.capabilities).not.toContain("cloud.terminal")
            expect(body.capabilities).not.toContain("cloud.pat")
          }
        }
      }
    }
  })
})

/*
 * The cloud roles (src/cloudRoleTurn.ts): a turn whose `role` is `librarian`
 * or `flows` is answered by this Worker on Cerebras and never reaches the
 * chat upstream; every other role rides upstream as a hint. The ceilings a
 * cloud role turn spends are the ones an upstream turn spends.
 */
describe("cloud roles on Cerebras", () => {
  const CEREBRAS = "https://api.cerebras.ai/v1/chat/completions"
  const completion = (content: string, model = "gpt-oss-120b"): Response =>
    Response.json({ model, choices: [{ message: { content } }] })

  const recordingLimits = (): TurnLimitNamespace & { readonly spends: () => ReadonlyArray<string> } => {
    const spent: Array<string> = []
    return {
      spends: () => spent,
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          if (new URL(request.url).pathname === "/spend") spent.push(String(id))
          return Response.json({ allowed: true, remaining: 1 })
        }
      })
    }
  }

  const network = (
    cerebras: (request: Request) => Response,
    upstream: (request: Request) => Response = () => ndjsonUpstream([{ type: "done" }])
  ) => {
    const calls = { cerebras: [] as Array<Request>, upstream: [] as Array<Request>, identity: 0 }
    const handler = (request: Request): Response | undefined => {
      const host = new URL(request.url).hostname
      if (request.url === CEREBRAS) {
        calls.cerebras.push(request)
        return cerebras(request)
      }
      if (host === "upstream.test") {
        calls.upstream.push(request)
        return upstream(request)
      }
      if (host === "identity.test") {
        calls.identity += 1
        return new Response("{}", { status: 401 })
      }
      return undefined
    }
    return { calls, handler }
  }

  const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat", CEREBRAS_API_KEY: "csk-test" }
  const librarian = { ...turnBody, runId: "run-librarian", role: "librarian", purpose: "librarian" }

  test("a librarian turn reaches Cerebras on the librarian model and never the chat upstream", async () => {
    const wire = network(() => completion("Triggers live in flows/triggers.ts."))
    await withMockedFetch(wire.handler, async () => {
      const response = await worker.fetch(post("/api/agent/turn", librarian), env)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/x-ndjson")
      const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
      expect(frames).toEqual([
        { runId: "run-librarian", type: "delta", kind: "text", text: "Triggers live in flows/triggers.ts." },
        { runId: "run-librarian", type: "done", reason: "stop" }
      ])
    })
    expect(wire.calls.upstream.length).toBe(0)
    expect(wire.calls.cerebras.length).toBe(1)
    expect(wire.calls.cerebras[0]!.headers.get("authorization")).toBe("Bearer csk-test")
    const sent = (await wire.calls.cerebras[0]!.json()) as { model: string; messages: Array<{ role: string; content: string }> }
    expect(sent.model).toBe("gpt-oss-120b")
    expect(sent.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello who are you" }
    ])
  })

  test("the deployment's CEREBRAS_MODEL_LIBRARIAN and CEREBRAS_MODEL_FLOWS override the served models", async () => {
    const wire = network(() => completion("ok"))
    await withMockedFetch(wire.handler, async () => {
      const models = { ...env, CEREBRAS_MODEL_LIBRARIAN: "gemma-4-31b", CEREBRAS_MODEL_FLOWS: "gpt-oss-120b" }
      await (await worker.fetch(post("/api/agent/turn", librarian), models)).text()
      await (await worker.fetch(post("/api/agent/turn", { ...librarian, runId: "run-flows", role: "flows", purpose: "flows" }), models)).text()
    })
    const sent = await Promise.all(wire.calls.cerebras.map(async (request) => ((await request.json()) as { model: string }).model))
    expect(sent).toEqual(["gemma-4-31b", "gpt-oss-120b"])
    expect(wire.calls.upstream.length).toBe(0)
  })

  test("a tool-bearing librarian body is refused with 400 and spends nothing anywhere", async () => {
    const wire = network(() => completion("never"))
    const tools = [{ type: "function", name: "commands", description: "the one tool", parameters: { type: "object", properties: {} } }]
    await withMockedFetch(wire.handler, async () => {
      const response = await worker.fetch(post("/api/agent/turn", { ...librarian, tools }), env)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toContain("Librarian")
    })
    expect(wire.calls.cerebras.length).toBe(0)
    expect(wire.calls.upstream.length).toBe(0)
  })

  test("an explainer turn rides upstream carrying tier, purpose and role; unknown hint values are dropped, never refused", async () => {
    const wire = network(() => completion("never"), () => ndjsonUpstream([{ type: "delta", kind: "text", text: "Because." }, { type: "done" }]))
    await withMockedFetch(wire.handler, async () => {
      const explained = await worker.fetch(
        post("/api/agent/turn", { ...turnBody, runId: "run-explain", tier: "cheap", purpose: "explain", role: "explainer" }),
        env
      )
      expect(explained.status).toBe(200)
      await explained.text()
      const odd = await worker.fetch(
        post("/api/agent/turn", { ...turnBody, runId: "run-odd", tier: "gold", purpose: "p".repeat(201), role: "Not A Role" }),
        env
      )
      expect(odd.status).toBe(200)
      await odd.text()
    })
    expect(wire.calls.cerebras.length).toBe(0)
    expect(wire.calls.upstream.length).toBe(2)
    expect(await wire.calls.upstream[0]!.json()).toEqual({
      messages: turnBody.messages,
      instructions: turnBody.instructions,
      tier: "cheap",
      purpose: "explain",
      role: "explainer"
    })
    expect(await wire.calls.upstream[1]!.json()).toEqual({ messages: turnBody.messages, instructions: turnBody.instructions })
  })

  test("a signed-out catalog turn on the librarian spends the anonymous ceilings once and runs on Cerebras", async () => {
    const limits = recordingLimits()
    const gated: WorkerEnv = { ...env, IDENTITY_UPSTREAM_URL: "https://identity.test", TURN_LIMITS: limits }
    const exploring = {
      ...librarian,
      runId: "run-anon-librarian",
      context: {
        version: 1,
        product: "smithers",
        capturedAt: 1786223000000,
        revision: 3,
        surface: "chat",
        theme: "light",
        selectedWorldDocument: null,
        connectors: [],
        activeRepository: "smithersai/smithers",
        github: { connected: false, login: null, repositories: null },
        worldState: { documentCount: 0, documents: [] },
        capabilities: [],
        limitations: []
      }
    }
    const wire = network(() => completion("It is a monorepo."))
    await withMockedFetch(wire.handler, async () => {
      const response = await worker.fetch(post("/api/agent/turn", exploring), gated)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("It is a monorepo.")
      // The same body about a repository outside the catalog keeps the sign-in 401.
      const refused = await worker.fetch(
        post("/api/agent/turn", { ...exploring, runId: "run-anon-private", context: { ...exploring.context, activeRepository: "someone/private" } }),
        gated
      )
      expect(refused.status).toBe(401)
    })
    expect(wire.calls.identity).toBe(2)
    expect(wire.calls.cerebras.length).toBe(1)
    expect(wire.calls.upstream.length).toBe(0)
    const spends = limits.spends()
    expect(spends.length).toBe(2)
    expect(spends.filter((key) => key.startsWith("anonymous:") && key !== "anonymous:all").length).toBe(1)
    expect(spends.filter((key) => key === "anonymous:all").length).toBe(1)
    // The system message carries the runtime context the client derived, rendered server-side.
    const sent = (await wire.calls.cerebras[0]!.json()) as { messages: Array<{ role: string; content: string }> }
    expect(sent.messages[0]!.role).toBe("system")
    expect(sent.messages[0]!.content).toContain("smithersai/smithers")
  })

  test("without a Cerebras key the librarian is an honest 503 and the chat upstream is never asked instead", async () => {
    const wire = network(() => completion("never"))
    await withMockedFetch(wire.handler, async () => {
      const response = await worker.fetch(post("/api/agent/turn", librarian), { ...env, CEREBRAS_API_KEY: undefined })
      expect(response.status).toBe(503)
      expect(((await response.json()) as { message: string }).message).toContain("CEREBRAS_API_KEY is unset")
    })
    expect(wire.calls.cerebras.length).toBe(0)
    expect(wire.calls.upstream.length).toBe(0)
  })
})

/*
 * The identity and billing workers each expose an admin surface behind
 * `x-smithers-admin-token`. The product spends that token only from its own
 * /api/admin/* routes, after the caller's session validates as admin:true.
 * The transparent proxies must therefore never carry a client-supplied admin
 * token, and must never reach the siblings' admin paths at all.
 */
describe("sibling admin surfaces are unreachable through the transparent proxies", () => {
  const env: WorkerEnv = {
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    BILLING_UPSTREAM_URL: "https://billing.test",
    BILLING_PRODUCT_SERVICE_TOKEN: "product-service-token-123"
  }

  test("a client-supplied x-smithers-admin-token is stripped by both proxies, even for an admin session", async () => {
    const seen: Array<{ host: string; path: string; token: string | null }> = []
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname !== "identity.test" && url.hostname !== "billing.test") return undefined
        if (url.pathname === "/api/identity/validate") {
          return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        seen.push({ host: url.hostname, path: url.pathname, token: request.headers.get("x-smithers-admin-token") })
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
      async () => {
        for (const path of ["/api/identity/whoami", "/api/billing/balance"]) {
          const response = await worker.fetch(
            new Request(`https://mvp.test${path}`, {
              headers: { cookie: "smithers_session=abc", "x-smithers-admin-token": "forged" }
            }),
            env
          )
          expect(`${path} → ${response.status}`).toBe(`${path} → 200`)
        }
        expect(seen.map((call) => call.path)).toEqual(["/api/identity/whoami", "/api/billing/balance"])
        for (const call of seen) expect(`${call.host} ${call.path}: ${call.token}`).toBe(`${call.host} ${call.path}: null`)
      }
    )
  })

  test("the siblings' admin paths answer the canonical 404 and are never forwarded", async () => {
    const forwarded: Array<string> = []
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname !== "identity.test" && url.hostname !== "billing.test") return undefined
        forwarded.push(url.pathname)
        return new Response("{}", { status: 200 })
      },
      async () => {
        for (const [method, path] of [
          ["GET", "/api/identity/admin/allowlist"],
          ["POST", "/api/identity/admin/allowlist"],
          ["GET", "/api/identity/admin/requests"],
          ["GET", "/api/billing/admin/grants"],
          ["POST", "/api/billing/admin/grants"]
        ] as const) {
          const response = await worker.fetch(
            new Request(`https://mvp.test${path}`, {
              method,
              headers: { "x-smithers-admin-token": "forged", cookie: "smithers_session=abc" }
            }),
            env
          )
          expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`)
          expect(await response.json()).toEqual({ status: "error", message: "Not found." })
        }
        expect(forwarded).toEqual([])
      }
    )
  })
})

describe("Durable Object rejections and the Worker error boundary", () => {
  const cause = new Error("Durable Object reset because its code was updated.")
  const rejectingNamespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => { throw cause } })
  }

  for (const path of ["/api/agent/turn", "/api/agent/turn/cancel"]) {
    test(`a rejected registry fetch on ${path} answers a JSON 502`, async () => {
      let upstreamCalls = 0
      await withMockedFetch(() => {
        upstreamCalls += 1
        return new Response("unexpected upstream call", { status: 500 })
      }, async () => {
        const response = await worker.fetch(post(path, turnBody), {
          ...assetsEnv(), TURN_CANCELS: rejectingNamespace
        })
        expect(response.status).toBe(502)
        expect(response.headers.get("content-type")).toContain("application/json")
        expect(await response.json()).toMatchObject({ status: "error", message: expect.any(String) })
        expect(upstreamCalls).toBe(0)
      })
    })
  }

  test("a rejected admin log read returns an empty log with an unavailable note", async () => {
    await withMockedFetch(() => new Response(JSON.stringify({
      login: "will", allowlisted: true, admin: true
    }), { headers: { "content-type": "application/json" } }), async () => {
      const response = await worker.fetch(new Request("https://mvp.test/api/admin/errors", {
        headers: { cookie: "smithers_session=abc" }
      }), {
        ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test", CLIENT_ERRORS: rejectingNamespace
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        status: "ok", total: 0, reports: [], note: "The client-error log is unavailable right now. Try again in a moment."
      })
    })
  })

  test("the error boundary awaits promises returned by route handlers", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      const response = await worker.fetch(post("/api/agent/turn", turnBody), {
        ...assetsEnv(),
        TURN_CANCELS: { ...rejectingNamespace, idFromName: () => { throw cause } }
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        status: "error", message: "Smithers could not complete this request. Try again in a moment."
      })
      expect(logged).toHaveBeenCalledWith("worker fetch failed:", cause)
    } finally {
      logged.mockRestore()
    }
  })

  for (const failure of [new Error("asset backend failed"), "non-Error rejection"]) {
    test(`an unhandled route rejection becomes a logged JSON 500 (${String(failure)})`, async () => {
      const logged = spyOn(console, "error").mockImplementation(() => {})
      try {
        const response = await worker.fetch(new Request("https://mvp.test/"), {
          ASSETS: { fetch: async () => { throw failure } }
        })
        expect(response.status).toBe(500)
        expect(response.headers.get("content-type")).toContain("application/json")
        expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin")
        expect(await response.json()).toEqual({
          status: "error", message: "Smithers could not complete this request. Try again in a moment."
        })
        expect(logged).toHaveBeenCalledWith("worker fetch failed:", failure)
      } finally {
        logged.mockRestore()
      }
    })
  }
})

describe("configured upstream headers deadlines", () => {
  const deadlineEnv = (): WorkerEnv => ({
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "service-token",
    IDENTITY_ADMIN_TOKEN: "identity-admin",
    BILLING_UPSTREAM_URL: "https://billing.test",
    BILLING_ADMIN_TOKEN: "billing-admin",
    BILLING_AUTH_TOKEN: "billing-bearer",
    SMITHERS_CHAT_URL: "https://chat.test/chat",
    UPSTREAM_TIMEOUT_MS: "20"
  })

  // The watchdog releases a broken implementation so the regression fails
  // without leaving a fetch or its default 20-second timer behind.
  const stalledHeaders = (request: Request, aborted: string[]): Promise<Response> =>
    new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => resolve(new Response("watchdog", { status: 598 })), 1_000)
      const abort = () => {
        clearTimeout(watchdog)
        aborted.push(new URL(request.url).pathname)
        reject(request.signal.reason)
      }
      if (request.signal.aborted) abort()
      else request.signal.addEventListener("abort", abort, { once: true })
    })

  const validate = (request: Request): Response | undefined =>
    new URL(request.url).pathname === "/api/identity/validate"
      ? Response.json({ login: "deadline-admin", allowlisted: true, admin: true })
      : undefined

  test.each([
    ["/api/agent/turn", turnBody],
    ["/api/model/stream", { messages: turnBody.messages, instructions: turnBody.instructions }],
    ["/api/admin/allowlist", { login: "octocat", action: "add" }],
    ["/api/admin/grant", { login: "octocat", amountUsd: 1 }],
    ["/api/admin/requests", undefined]
  ] as const)("%s returns 504 naming its configured 20 ms deadline", async (path, body) => {
    const aborted: string[] = []
    const cancels = memoryCancels()
    await withMockedFetch(
      (request) => validate(request) ?? stalledHeaders(request, aborted),
      async () => {
        const response = await worker.fetch(
          body === undefined ? new Request(`https://mvp.test${path}`) : post(path, body),
          { ...deadlineEnv(), TURN_CANCELS: cancels }
        )
        expect(response.status).toBe(504)
        expect(await response.json()).toEqual({
          status: "error",
          message: expect.stringContaining("20ms")
        })
        expect(aborted).toHaveLength(1)
        if (path === "/api/agent/turn") {
          const registry = cancels.get(cancels.idFromName(turnBody.runId))
          expect(await (await registry.fetch(new Request("https://turn-cancel.internal/state", {
            headers: { "x-turn-generation": cancels.generations.get(turnBody.runId)! }
          }))).json())
            .toEqual({ state: "settled" })
          expect(await (await worker.fetch(post("/api/agent/turn/cancel", { runId: turnBody.runId }), deadlineEnv())).json())
            .toEqual({ status: "not-found" })
        }
      }
    )
  })

  test("admin health bounds both healthz reads, balance and queue with the configured deadline", async () => {
    const aborted: string[] = []
    await withMockedFetch(
      (request) => validate(request) ?? stalledHeaders(request, aborted),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/admin/health"), deadlineEnv())
        expect(response.status).toBe(200)
        const body = await response.json() as {
          services: Array<{ status: string; detail: string }>
          charges: unknown
          queueDepth: unknown
        }
        expect(aborted.sort()).toEqual(["/api/billing/balance", "/api/identity/admin/requests", "/healthz", "/healthz"])
        expect(body.services).toHaveLength(2)
        for (const service of body.services) {
          expect(service.status).toBe("failed")
          expect(service.detail).toContain("20ms")
        }
        expect(body.charges).toBeNull()
        expect(body.queueDepth).toBeNull()
      }
    )
  })
})

describe("generation-scoped turn lifecycle", () => {
  test("a delayed EOF cannot settle the continuation registered after done", async () => {
    const cancels = memoryCancels()
    let settlements = 0
    const env = { ...assetsEnv(), TURN_CANCELS: {
      ...cancels,
      get: (id: unknown) => ({ fetch: (request: Request) => {
        if (new URL(request.url).pathname === "/settle") settlements += 1
        return cancels.get(id).fetch(request)
      } })
    } }
    let first!: ReadableStreamDefaultController<Uint8Array>
    let call = 0
    await withMockedFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (call++ === 0) {
          first = controller
          controller.enqueue(new TextEncoder().encode('{"type":"done","reason":"stop"}\n'))
        }
      }
    })), async () => {
      const request = () => post("/api/agent/turn", { ...turnBody, runId: "generation-eof" })
      const old = (await worker.fetch(request(), env)).body!.getReader()
      expect(JSON.parse(new TextDecoder().decode((await old.read()).value)).type).toBe("done")
      const next = await worker.fetch(request(), env)
      expect(next.status).toBe(200)
      try {
        first.close()
        expect((await old.read()).done).toBe(true)
        await Bun.sleep(10) // let the old pipe's finalizer run
        expect(settlements).toBe(1)
        const kill = await worker.fetch(post("/api/agent/turn/cancel", { runId: "generation-eof" }), env)
        expect(await kill.json()).toEqual({ status: "cancelled" })
      } finally {
        await next.body!.cancel()
      }
    })
  })

  test("stale generation state, cancel and settle cannot affect a replacement", async () => {
    const storage = memoryStorage()
    const registry = new TurnCancelRegistry({ storage })
    const first = await (await doPost(registry, "/register")).json() as { generation: string }
    const state = await storage.get<Record<string, unknown>>("state")
    await storage.put("state", { ...state, at: Date.now() - 11 * 60 * 1000 })
    await doPost(registry, "/register")
    const scoped = (path: string) => registry.fetch(new Request(`https://turn-cancel.internal${path}`, {
      method: "POST", headers: { "x-turn-generation": first.generation ?? "missing-generation" }
    }))
    expect(await (await scoped("/state")).json()).toEqual({ state: "unknown" })
    expect(await (await scoped("/cancel")).json()).toEqual({ status: "not-found" })
    await scoped("/settle")
    for (const path of ["/state", "/cancel", "/settle"]) {
      expect(await (await registry.fetch(new Request(`https://turn-cancel.internal${path}`))).json())
        .toEqual(path === "/state" ? { state: "unknown" } : { status: "not-found" })
    }
    expect((await storage.get<{ state: string }>("state"))?.state).toBe("active")
  })

  test("disconnect settlement is kept alive by waitUntil", async () => {
    const storage = memoryStorage()
    const registry = new TurnCancelRegistry({ storage })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let settling!: () => void
    const started = new Promise<void>((resolve) => { settling = resolve })
    const env: WorkerEnv = { ...assetsEnv(), TURN_CANCELS: {
      idFromName: (id) => id,
      get: () => ({ fetch: async (request) => {
        if (new URL(request.url).pathname === "/settle") {
          settling()
          await blocked
        }
        return registry.fetch(request)
      } })
    } }
    const pending: Promise<unknown>[] = []
    await withMockedFetch(() => new Response(new ReadableStream<Uint8Array>()), async () => {
      const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "generation-disconnect" }), env,
        { waitUntil: (promise) => { pending.push(promise) } })
      const disconnect = turn.body!.cancel("client disconnected")
      await started
      try {
        expect(pending.length).toBeGreaterThan(0)
        let finished = false
        const cleanup = Promise.all(pending).then(() => { finished = true })
        await Bun.sleep(1)
        expect(finished).toBe(false)
        release()
        await cleanup
        expect((await storage.get<{ state: string }>("state"))?.state).toBe("settled")
      } finally {
        release()
        await disconnect
      }
    })
  })

  test.each(["rejection", "invalid response"])("a registry %s ends monitoring and logs cleanup rejections", async (failure) => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    const stateError = new Error("state transport failed")
    const settleError = new Error("settle transport failed")
    const cancelError = new Error("upstream cancel failed")
    let settlements = 0
    const logged = spyOn(console, "error").mockImplementation(() => {})
    const pending: Promise<unknown>[] = []
    const env: WorkerEnv = { ...assetsEnv(), TURN_CANCELS: {
      idFromName: (id) => id,
      get: () => ({ fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/state") {
          if (failure === "rejection") throw stateError
          return new Response("unavailable", { status: 503 })
        }
        if (path === "/settle") { settlements += 1; throw settleError }
        return registry.fetch(request)
      } })
    } }
    try {
      await withMockedFetch(() => new Response(new ReadableStream<Uint8Array>({
        cancel() { throw cancelError }
      })), async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "generation-failure" }), env,
          { waitUntil: (promise) => { pending.push(promise) } })
        expect(JSON.parse((await turn.text()).trim())).toEqual({
          runId: "generation-failure", type: "done", reason: "stop",
          error: "The turn lost cancellation monitoring. Try again."
        })
        await Promise.all(pending)
        expect(settlements).toBe(1)
        expect(logged).toHaveBeenCalledWith("turn registry state failed:",
          failure === "rejection" ? stateError : expect.any(Error))
        expect(logged).toHaveBeenCalledWith("turn registry settle failed:", settleError)
        expect(logged).toHaveBeenCalledWith("turn upstream cancel failed:", cancelError)
      })
    } finally {
      logged.mockRestore()
    }
  })

  test("a silent upstream backs off and terminates before the cancel poll budget is spent", async () => {
    const storage = memoryStorage()
    const registry = new TurnCancelRegistry({ storage })
    let polls = 0
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    let signal!: AbortSignal
    const env: WorkerEnv = { ...assetsEnv(), TURN_CANCELS: {
      idFromName: (id) => id,
      get: () => ({ fetch: (request) => {
        if (new URL(request.url).pathname === "/state" && ++polls === 110) upstream.close()
        return registry.fetch(request)
      } })
    } }
    const realTimeout = globalThis.setTimeout
    let now = Date.now()
    const intervals: number[] = []
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      if (ms >= 500 && ms <= 5000) {
        intervals.push(ms)
        return realTimeout(() => { now += ms; callback() }, 0)
      }
      return realTimeout(callback, ms)
    }) as typeof setTimeout)
    try {
      await withMockedFetch((request) => {
        signal = request.signal
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { upstream = controller },
          cancel() { cancelled = true }
        }))
      }, async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "generation-poll-cap" }), env)
        const text = await turn.text()
        const frames = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        expect(frames).toEqual([{ runId: "generation-poll-cap", type: "done", reason: "stop",
          error: "The turn exceeded its cancellation monitoring limit. Try again." }])
        expect(polls).toBe(96)
        expect(intervals.slice(0, 5)).toEqual([500, 1000, 2000, 4000, 5000])
        expect(Math.max(...intervals)).toBe(5000)
        expect(cancelled).toBe(true)
        expect(signal.aborted).toBe(true)
        expect((await storage.get<{ state: string }>("state"))?.state).toBe("settled")
      })
    } finally {
      timer.mockRestore()
      clock.mockRestore()
    }
  })
})
