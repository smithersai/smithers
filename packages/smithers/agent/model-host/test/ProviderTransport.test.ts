import { Effect, Exit } from "effect"
import { HttpClient } from "effect/http/HttpClient"
import { afterEach, describe, expect, test, vi } from "vitest"
import { providerTransport, refusingRedirects } from "../src/ProviderTransport.vibe"

type Fetch = typeof globalThis.fetch
const fetchOf = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Fetch =>
  Object.assign(impl, { preconnect() {} })

/** A response a browser hands back for `redirect: "manual"`: type `opaqueredirect`, status 0. */
const opaqueRedirect = (): Response => {
  const response = new Response(null, { status: 200 })
  Object.defineProperty(response, "type", { value: "opaqueredirect" })
  Object.defineProperty(response, "status", { value: 0 })
  return response
}

const get = (layer: ReturnType<typeof providerTransport>) =>
  Effect.runPromiseExit(
    Effect.gen(function*() {
      const client = yield* HttpClient
      return (yield* client.get("https://fixture.test/")).status
    }).pipe(Effect.provide(layer))
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("refusingRedirects", () => {
  test("never follows a redirect: the call fails and the refused status is told", async () => {
    const seen: Array<RequestRedirect | undefined> = []
    const refused: Array<number> = []
    let cancelled = false
    const guarded = refusingRedirects(
      fetchOf(async (_input, init) => {
        seen.push(init?.redirect)
        return new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), { status: 307 })
      }),
      (status) => refused.push(status)
    )
    await expect(guarded("https://fixture.test/", { redirect: "follow" })).rejects.toThrow(
      "model provider redirect refused"
    )
    expect(seen).toEqual(["manual"])
    expect(refused).toEqual([307])
    expect(cancelled).toBe(true)
  })

  test("refuses a browser's opaque redirect, which has no status to tell", async () => {
    const refused: Array<number> = []
    const guarded = refusingRedirects(fetchOf(async () => opaqueRedirect()), (status) => refused.push(status))
    await expect(guarded("https://fixture.test/")).rejects.toThrow("model provider redirect refused")
    expect(refused).toEqual([])
  })

  test("passes every other answer through untouched, with or without a listener", async () => {
    for (const status of [200, 299, 400, 404, 500]) {
      const answer = new Response(null, { status })
      const refused: Array<number> = []
      expect(await refusingRedirects(fetchOf(async () => answer), (seen) => refused.push(seen))("https://x.test/"))
        .toBe(answer)
      expect(refused).toEqual([])
    }
    await expect(refusingRedirects(fetchOf(async () => new Response(null, { status: 302 })))("https://x.test/"))
      .rejects.toThrow("model provider redirect refused")
  })
})

describe("providerTransport", () => {
  test("is an HttpClient whose call fails on a redirect and reports its status", async () => {
    const refused: Array<number> = []
    const exit = await get(
      providerTransport(fetchOf(async () => new Response(null, { status: 301 })), (status) => refused.push(status))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(refused).toEqual([301])
  })

  test("defaults to the runtime's global fetch", async () => {
    vi.stubGlobal("fetch", fetchOf(async () => new Response(null, { status: 204 })))
    expect(await get(providerTransport())).toEqual(Exit.succeed(204))
  })
})
