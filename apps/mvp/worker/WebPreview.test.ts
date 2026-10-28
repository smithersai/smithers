// `POST /api/web/preview` (worker/WebPreview.ts, docs/features/web-pages.md#before-a-page-is-framed), through ChatApi's
// real handler, `@smthrs/views`' real check and Effect's real fetch client. Outside pages answer from worker/test/pages.ts
// (the outside web is a third party, scripted like the model); a page on this machine is a real HTTP server.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { MAX_PREVIEW_BODY_BYTES } from "../src/features/web/contract.ts"
import * as Actor from "./Actor.ts"
import { harness, recorded, testFile } from "./test/harness.ts"
import { framable, outsideWeb, type Page, refusing } from "./test/pages.ts"
import * as WebPreview from "./WebPreview.ts"

const runtime = testFile("web_preview")

const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const ALLOWS = "https://allows.example/guide"
const DENIES = "https://denies.example/"

/**
 * ChatApi as `actor` (a Member unless `null`), with `pages` as the outside web and `config` as its environment. `asked`
 * holds every outside URL it requested.
 */
const open = async (
  options: {
    readonly actor?: Actor.Actor | null
    readonly pages?: Record<string, Page>
    readonly config?: Record<string, string>
    readonly sessions?: Layer.Layer<Actor.Sessions>
  } = {},
) => {
  const asked: Array<string> = []
  const h = await harness(runtime, () => Stream.empty, {
    fetch: outsideWeb(options.pages ?? { [ALLOWS]: framable(), [DENIES]: refusing() }, asked),
    ...(options.actor === null ? {} : { actor: options.actor ?? member }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  })
  const check = (body: unknown, init: RequestInit = {}) =>
    h.fetch("/api/web/preview", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    })
  return { h, asked, check }
}

describe("POST /api/web/preview", () => {
  test("answers whether a frame shows the page, with what a card shows, by the app's origin as the frame's parent", async () => {
    const { h, check } = await open({
      pages: {
        [ALLOWS]: framable(),
        [DENIES]: refusing(),
        "https://ancestors.example/": { headers: { "content-security-policy": "frame-ancestors http://chat.test" } },
        "https://elsewhere.example/": { headers: { "content-security-policy": "frame-ancestors https://chat.test" } },
      },
    })

    const allowed = await check({ url: ALLOWS, mode: "embed" })
    expect([allowed.status, allowed.headers.get("cache-control")]).toEqual([200, "no-store"])
    expect(await allowed.json()).toEqual({
      framing: "allowed",
      status: 200,
      title: "Frames welcome",
      description: "A page that lets others frame it.",
      icon: "https://allows.example/icon.png",
    })
    expect(await (await check({ url: DENIES, mode: "embed" })).json()).toEqual({
      framing: "refused",
      reason: "x_frame_options",
      status: 200,
      title: "Frames refused",
      description: "A page that never shows in a frame.",
      icon: "https://denies.example/favicon.ico",
    })
    // The app is http://chat.test here: the page's frame-ancestors is matched against it.
    expect(await (await check({ url: "https://ancestors.example/", mode: "embed" })).json()).toMatchObject({
      framing: "allowed",
    })
    expect(await (await check({ url: "https://elsewhere.example/", mode: "tab" })).json()).toMatchObject({
      framing: "refused",
      reason: "frame_ancestors",
    })

    expect(h.line("chat.web.preview").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ mode: "embed", framing: "allowed", cached: false, status: 200 }),
      expect.objectContaining({ mode: "embed", framing: "refused", framingReason: "x_frame_options", status: 200 }),
      expect.objectContaining({ framing: "allowed" }),
      expect.objectContaining({ mode: "tab", framing: "refused", framingReason: "frame_ancestors" }),
    ])
    expect(h.count(WebPreview.previews, { status: "200", framing: "allowed" })).toBe(2)
    expect(h.count(WebPreview.previews, { status: "200", framing: "refused" })).toBe(2)
    const spans = h.span("chat.web.preview").map((span) => Object.fromEntries(span.attributes))
    expect(spans[1]).toMatchObject({ "http.response.status_code": 200, "smithers.web.framing": "refused" })
    expect(h.span("WebPage.check")).toHaveLength(4)
  })

  test("a page that can't be read is an answer, not a failure", async () => {
    const { check, asked } = await open({ pages: { "https://broken.example/": { status: 500 } } })
    expect(await (await check({ url: "https://broken.example/", mode: "embed" })).json()).toEqual({
      framing: "unknown",
      reason: "status",
      status: 500,
      icon: "https://broken.example/favicon.ico",
    })
    expect(await (await check({ url: "https://offline.example/", mode: "embed" })).json()).toEqual({
      framing: "unknown",
      reason: "unreachable",
    })
    expect(asked).toEqual(["https://broken.example/", "https://offline.example/"])
  })

  test("keeps a page's answer for WEB_PAGE_CHECK_KEPT, then asks the page again", async () => {
    const { h, check, asked } = await open()
    expect((await check({ url: ALLOWS, mode: "embed" })).status).toBe(200)
    expect(await (await check({ url: ALLOWS, mode: "tab" })).json()).toMatchObject({ framing: "allowed" })
    expect(asked).toEqual([ALLOWS])
    expect(h.line("chat.web.preview").map((line) => line.annotations.cached)).toEqual([false, true])

    // Kept for a millisecond, the answer is asked again once a millisecond has passed.
    const brief = await open({ config: { WEB_PAGE_CHECK_KEPT: "1 millis" } })
    for (let request = 0; brief.asked.length < 2 && request < 50; request++) {
      expect((await brief.check({ url: ALLOWS, mode: "embed" })).status).toBe(200)
    }
    expect(brief.asked).toEqual([ALLOWS, ALLOWS])
  })

  test("a zero cache duration asks the real page on every request", async () => {
    let served = 0
    const server = createServer((_request, response) => {
      served++
      response.writeHead(200, { "content-type": "text/html" })
      response.end(`<title>Version ${served}</title>`)
    })
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve))
    try {
      const url = `http://localhost:${(server.address() as AddressInfo).port}/`
      const { h, check } = await open({ config: { WEB_PAGES_LOCAL_HTTP: "true", WEB_PAGE_CHECK_KEPT: "0 millis" } })
      for (let version = 1; version <= 3; version++) {
        const response = await check({ url, mode: "tab" })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ title: `Version ${version}` })
      }
      expect(served).toBe(3)
      expect(h.line("chat.web.preview").map((line) => line.annotations.cached)).toEqual([false, false, false])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("never asks a private or local host, and reads this machine's pages only under development", async () => {
    let served = 0
    const server: Server = createServer((_request, response) => {
      served++
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<title>On this machine</title>")
    })
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve))
    const local = `http://localhost:${(server.address() as AddressInfo).port}/`
    try {
      const deployed = await open({ config: { WEB_PAGES_LOCAL_HTTP: "false" } })
      for (const url of ["https://127.0.0.1/", "https://169.254.169.254/latest/", "https://printer.local/"]) {
        expect([url, await (await deployed.check({ url, mode: "embed" })).json()]).toEqual([
          url,
          { framing: "unknown", reason: "private_host" },
        ])
      }
      // http://localhost is refused by the policy itself outside development.
      expect((await deployed.check({ url: local, mode: "tab" })).status).toBe(400)
      expect(deployed.asked).toEqual([])

      const development = await open({ config: { WEB_PAGES_LOCAL_HTTP: "true" } })
      expect(await (await development.check({ url: local, mode: "tab" })).json()).toEqual({
        framing: "allowed",
        status: 200,
        title: "On this machine",
      })
      expect(served).toBe(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("refuses what the policy refuses, and anyone signed out, asking nothing; anyone signed in previews (ruling AUTH-8)", async () => {
    const { h, check, asked } = await open()
    const refused = async (response: Response) => [response.status, await response.json()]
    expect(await refused(await check({ url: "javascript:alert(1)", mode: "embed" }))).toEqual([400, { code: "refused" }])
    expect(await refused(await check({ url: "https://chat.test/app", mode: "tab" }))).toEqual([400, { code: "refused" }])
    expect(await refused(await check({ url: ALLOWS, mode: "frame" }))).toEqual([400, { code: "invalid" }])
    expect(await refused(await check("{"))).toEqual([400, { code: "invalid" }])
    expect(await refused(await check({ url: `https://a.example/${"a".repeat(MAX_PREVIEW_BODY_BYTES)}`, mode: "tab" })))
      .toEqual([413, { code: "too_large" }])
    expect(await refused(await h.fetch("/api/web/preview", { method: "POST", body: new Uint8Array([0xff, 0xfe]) }))).toEqual([
      400,
      { code: "invalid" },
    ])
    const get = await h.fetch("/api/web/preview")
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
    expect(h.line("chat.web.preview").map((line) => line.annotations.reason).slice(0, 2)).toEqual([
      "scheme",
      "same_origin",
    ])

    const signedOut = await open({ actor: null })
    expect(await refused(await signedOut.check({ url: ALLOWS, mode: "embed" }))).toEqual([401, { code: "authentication" }])
    expect([...asked, ...signedOut.asked]).toEqual([])
    expect(h.count(WebPreview.previews, { status: "400" })).toBe(5)
    // A Guest of the deployment's repository, or someone with no role, previews a page: it adds nothing anywhere.
    for (const role of ["guest", null] as const) {
      const stranger = await open({ actor: { subject: { kind: "person", id: `person-${role ?? "none"}` }, role } })
      expect((await stranger.check({ url: ALLOWS, mode: "embed" })).status, String(role)).toBe(200)
      expect(stranger.asked, String(role)).toHaveLength(1)
    }
  })

  test("sessions that can't be read are 503, logged by their error code", async () => {
    const down = Layer.succeed(
      Actor.Sessions,
      Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }),
    )
    const { h, check } = await open({ sessions: down })
    expect([(await check({ url: ALLOWS, mode: "embed" })).status]).toEqual([503])
    expect(h.only("chat.web.preview")).toMatchObject({ level: "ERROR", annotations: { status: 503 } })
    expect(h.only("chat.web.preview").annotations.errorCode).toEqual(expect.any(String))
  })

  test("no record carries the page", async () => {
    const sentinel = "sentinel-0b5e"
    const url = `https://${sentinel}.example/${sentinel}?q=${sentinel}`
    const { h, check } = await open({ pages: { [url]: refusing(sentinel) } })
    expect((await check({ url, mode: "embed" })).status).toBe(200)
    expect((await check({ url: `javascript:${sentinel}`, mode: "embed" })).status).toBe(400)
    expect(recorded(h)).not.toContain(sentinel)
  })
})
