import { describe, expect, it } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { testConfigLayer } from "./Config"
import { transportLayer } from "./Http"
import { handleTutorialProviderProxy } from "./tutorialProviderProxy"
import { tutorialProviderDestinations } from "@smthrs/rpc/TutorialProviderProxy"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

describe("private Cloudflare tutorial provider proxy", () => {
  it("routes through the deployed Worker without allowing browser credentials to replace the service token", async () => {
    const env = { ...memoryDurableObjects(), TUTORIAL_SERVICE_TOKEN: "private-token", ASSETS: { fetch: async () => new Response("unexpected asset") } }
    const response = await worker.fetch(new Request("https://smithers.sh/api/tutorial/provider/chatgpt", { method: "POST", headers: { cookie: "__Host-smithers-tutorial=visitor-session" }, body: "{}" }), env)
    expect(response.status).toBe(401)
    expect(await response.text()).toContain("Service authentication required")
    const crossOrigin = await worker.fetch(new Request("https://smithers.sh/api/tutorial/provider/chatgpt", { method: "POST", headers: { origin: "https://evil.invalid", "x-smithers-proxy-token": "private-token" }, body: "{}" }), env)
    expect(crossOrigin.status).toBe(403)
  })
  it("authenticates before forwarding and refuses arbitrary destinations, query strings, methods, and oversized bodies", async () => {
    let calls = 0
    const services = Layer.mergeAll(testConfigLayer({ tutorialServiceToken: Redacted.make("private-token") }), transportLayer(async () => { calls++; return Response.json({}) }))
    const run = (path: string, init?: RequestInit) => Effect.runPromise(handleTutorialProviderProxy(new Request(`https://smithers.sh/api/tutorial/provider/${path}`, init)).pipe(Effect.provide(services)))
    expect((await run("chatgpt", { method: "POST" })).status).toBe(401)
    const headers = { "x-smithers-proxy-token": "private-token" }
    expect((await run("https://evil.invalid", { method: "POST", headers })).status).toBe(404)
    expect((await run("chatgpt?url=https://evil.invalid", { method: "POST", headers })).status).toBe(404)
    expect((await run("chatgpt", { headers })).status).toBe(405)
    expect((await run("chatgpt", { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413)
    expect(calls).toBe(0)
  })

  it("forwards all configured provider and refresh requests only to fixed destinations with selected headers", async () => {
    for (const [route, target] of Object.entries(tutorialProviderDestinations)) {
      const services = Layer.mergeAll(testConfigLayer({ tutorialServiceToken: Redacted.make("private-token") }), transportLayer(async (input, init) => {
        expect(String(input)).toBe(target)
        expect(init?.redirect).toBe("manual")
        const headers = new Headers(init?.headers)
        expect(headers.get("authorization")).toBe("Bearer provider-credential")
        expect(headers.get("chatgpt-account-id")).toBe("account")
        expect(headers.has("x-smithers-proxy-token")).toBe(false)
        expect(headers.has("cookie")).toBe(false)
        expect(headers.has("x-forwarded-host")).toBe(false)
        expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"model":"gpt-5.6-luna"}')
        return new Response("quota", { status: 429, headers: { "retry-after": "30", "set-cookie": "private=1", "authorization": "do-not-return" } })
      }))
      const request = new Request(`https://smithers.sh/api/tutorial/provider/${route}`, { method: "POST", headers: { "x-smithers-proxy-token": "private-token", authorization: "Bearer provider-credential", "chatgpt-account-id": "account", cookie: "local=1", "x-forwarded-host": "evil.invalid" }, body: '{"model":"gpt-5.6-luna"}' })
      const response = await Effect.runPromise(handleTutorialProviderProxy(request).pipe(Effect.provide(services)))
      expect(response.status).toBe(429)
      expect(response.headers.get("retry-after")).toBe("30")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-smithers-provider-proxy")).toBe("cloudflare")
      expect(response.headers.has("set-cookie")).toBe(false)
      expect(response.headers.has("authorization")).toBe(false)
    }
  })

  it("preserves streaming instead of waiting for completion and refuses redirects", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode("data: first\n\n")) } })
    let redirect = false
    const services = Layer.mergeAll(testConfigLayer({ tutorialServiceToken: Redacted.make("private-token") }), transportLayer(async () => redirect ? new Response(null, { status: 307, headers: { location: "https://evil.invalid" } }) : new Response(stream, { headers: { "content-type": "text/event-stream" } })))
    const run = () => Effect.runPromise(handleTutorialProviderProxy(new Request("https://smithers.sh/api/tutorial/provider/chatgpt", { method: "POST", headers: { "x-smithers-proxy-token": "private-token" }, body: "{}" })).pipe(Effect.provide(services)))
    const response = await run()
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n")
    streamController.close()
    redirect = true
    const refused = await run()
    expect(refused.status).toBe(502)
    expect(refused.headers.has("location")).toBe(false)
  })
})
