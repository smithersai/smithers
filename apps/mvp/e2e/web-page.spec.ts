import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { request as requests, type BrowserContext, type Request } from "@playwright/test"
import { WebPage } from "@smthrs/views"
import { certificate } from "../dev/https.ts"
import { VIEWS_ROUTE } from "../src/features/views/contract"
import { WEB_PREVIEW_ROUTE, CANT_OPEN } from "../src/features/web/contract"
import { expect, test } from "./devices"
import { wholeText } from "./console"
import { redactRequestErrors } from "./redact"
import { baseURL, requires, target, writeHeaders, sessionFiles } from "./target"

// Web pages, end to end (docs/features/web-pages.md): the real app, its engine worker, ChatApi, Electric and, for the
// agent's cases, the real model. Before a page is framed, ChatApi requests it from the server and reads its framing
// headers: a page that allows it shows in the chat, one that refuses shows as a card with its title, description,
// domain and icon. A person's own `/web` opens a tab straight from their keypress; a page the app won't open stays in the
// composer saying why. A view is a conversation row, so a second device shows it too. The agent's cases are few and
// short: Cerebras rate-limits calls.
//
// Local runs use real HTTPS/HTTP servers. A deployment uses public HTTPS pages instead: its Worker can reach them,
// and an unauthenticated client verifies their status, framing headers and preview before any journey relies on them.
// E2E_WEB_ALLOWS_URL, E2E_WEB_REFUSES_URL and E2E_WEB_TAB_URL may replace the public fixtures; an allowing fixture
// must have an h1, and a refusing fixture must provide title, description and an HTTPS icon.

/** The dev certificate, made by the dev server's first start (dev/https.ts). */
const DEV_CERTIFICATE = join(import.meta.dirname, "..", "node_modules", ".dev-https")

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0f766e"/></svg>`

/** A page with a title, a description and an icon, and the headers it is served with. */
const PAGES: Record<string, { readonly headers: Record<string, string>; readonly title: string; readonly description: string }> = {
  "/allows": { headers: {}, title: "Frames welcome", description: "A test page that lets the app frame it." },
  "/refuses": {
    headers: { "x-frame-options": "DENY" },
    title: "Frames refused",
    description: "A test page that refuses every frame, as many real sites do.",
  },
}

let framed: HttpsServer
let pages: string
let tabs: Server
let local: string
type Fixture = { readonly url: string; readonly preview: WebPage.Preview; readonly heading?: string; readonly documentTitle?: string }
let allows: Fixture
let refuses: Fixture
let tab: Fixture
let fixtureReceipts: Array<{ url: string; status: number; framing: string; headers: Record<string, string> }>

/** The views this context's engine worker added, as `POST /api/views` bodies, in order. */
const viewsAdded = (context: BrowserContext) => {
  const added: Array<{ readonly id: string; readonly template: string; readonly props: Record<string, string> }> = []
  context.on("request", (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === VIEWS_ROUTE) added.push(request.postDataJSON())
  })
  return added
}

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"

/** Typing a person can follow in the video. */
const typing = { delay: 30 }

test.describe("outside pages", () => {

  test.beforeAll(async () => {
    if (target === "local") {
      const { cert, key } = await certificate(DEV_CERTIFICATE)
      framed = createHttpsServer({ cert, key }, (request, response) => {
        const path = new URL(request.url ?? "/", "https://127.0.0.1").pathname
        if (path === "/icon.svg") {
          response.writeHead(200, { "content-type": "image/svg+xml" }).end(ICON)
          return
        }
        const page = PAGES[path]
        if (page === undefined) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...page.headers })
        response.end(
          `<!doctype html><title>${page.title}</title><meta name="description" content="${page.description}">` +
            `<link rel="icon" href="/icon.svg"><body style="font:16px system-ui;padding:24px"><h1>${page.title}</h1>`,
        )
      })
      await new Promise<void>((resolve) => framed.listen(0, "127.0.0.1", resolve))
      pages = `https://127.0.0.1:${(framed.address() as AddressInfo).port}`

      tabs = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end("<!doctype html><title>Local test page</title><h1>Local test page</h1>")
      })
      await new Promise<void>((resolve) => tabs.listen(0, "localhost", resolve))
      local = `http://localhost:${(tabs.address() as AddressInfo).port}`
    }

    // A fresh API context carries no app session or credentials to an outside site. Never disable TLS verification
    // for public fixtures: only the local servers use a self-signed development certificate.
    const client = await requests.newContext({ ignoreHTTPSErrors: target === "local" })
    const service = target === "deployment"
      ? await requests.newContext({ baseURL, storageState: sessionFiles(baseURL).session })
      : undefined
    if (service !== undefined) redactRequestErrors(service)
    fixtureReceipts = []
    const inspect = async (url: string, framing?: "allowed" | "refused", heading = false): Promise<Fixture> => {
      const parsed = URL.parse(url)
      expect(parsed !== null && parsed.username === "" && parsed.password === "", "fixtures use URLs without credentials").toBe(true)
      if (target === "deployment") expect(parsed!.protocol, "public fixtures use HTTPS").toBe("https:")
      const response = await client.get(url)
      expect(response.status(), `fixture ${url} is reachable`).toBe(200)
      expect(response.url(), "fixture URLs name their final page, so tab and frame assertions agree").toBe(url)
      const headers = response.headers()
      expect(headers["content-type"]).toContain("text/html")
      const checked = WebPage.framing(headers, { page: url, ancestors: [baseURL] })
      if (framing !== undefined) expect(checked.framing, `fixture framing headers at ${url}`).toBe(framing)
      if (framing === "refused") {
        expect("reason" in checked ? checked.reason : "missing reason").toMatch(/^(x_frame_options|frame_ancestors)$/)
      }
      const html = await response.text()
      const preview = WebPage.preview(html, url)
      const documentTitle = WebPage.preview(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)?.[0] ?? "", url).title
      if (preview.icon !== undefined) {
        const icon = await client.get(preview.icon)
        expect(icon.status(), "the fixture preview icon responds with an image").toBe(200)
        expect(icon.headers()["content-type"]).toMatch(/^image\//)
      }
      // The allowing fixture's actual heading will also be read inside the browser's real cross-origin frame.
      const headings = [...html.matchAll(/<h1\b[^>]*>([^<]+)<\/h1>/gi)]
      const h1 = headings[0]?.[1]?.trim()
      if (heading) expect(headings, "the allowing fixture has one plain-text h1").toHaveLength(1)
      if (heading) expect(h1, "the allowing fixture has a plain-text heading to prove it rendered").toBeTruthy()
      fixtureReceipts.push({
        url, status: response.status(), framing: checked.framing,
        headers: Object.fromEntries(Object.entries(headers).filter(([name]) =>
          ["content-type", "x-frame-options", "content-security-policy"].includes(name))),
      })
      // The runner and the deployed Worker can receive different responses (Python.org returned 403 only to the
      // Worker). Verify the actual service as well, before calling this a usable deployment fixture.
      if (target === "deployment") {
        const answer = await service!.post(WEB_PREVIEW_ROUTE, { data: { url, mode: "embed" }, headers: writeHeaders() })
        expect(answer.status(), "the deployed preview service can check the public fixture").toBe(200)
        const body = await answer.json() as WebPage.Checked
        expect(body).toMatchObject({ ...preview, status: 200, ...(framing === undefined ? {} : { framing }) })
      }
      return { url, preview, documentTitle, ...(heading ? { heading: h1! } : {}) }
    }
    try {
      allows = await inspect(target === "local" ? `${pages}/allows` : process.env.E2E_WEB_ALLOWS_URL ?? "https://rust-lang.org/", "allowed", true)
      refuses = await inspect(target === "local" ? `${pages}/refuses` : process.env.E2E_WEB_REFUSES_URL ?? "https://developer.mozilla.org/en-US/", "refused")
      // The fallback journey must still prove all metadata, even if an operator changes the fixture.
      expect(refuses.preview.title).toBeTruthy()
      expect(refuses.preview.description).toBeTruthy()
      expect(refuses.preview.icon).toMatch(/^https:/)
      tab = target === "local"
        ? { url: `${local}/`, preview: { title: "Local test page" }, documentTitle: "Local test page" }
        : await inspect(process.env.E2E_WEB_TAB_URL ?? "https://rust-lang.org/learn/", "allowed")
      expect(tab.preview.title).toBeTruthy()
      expect(tab.documentTitle).toBeTruthy()
    } finally {
      await client.dispose()
      await service?.dispose()
    }
  })
  test.beforeEach(async ({}, info) => {
    if (target === "local") requires("localServer")
    await info.attach("web-page-fixtures", { body: JSON.stringify(fixtureReceipts, null, 2), contentType: "application/json" })
  })
  test.afterAll(async () => {
    if (target !== "local") return
    if (framed) await new Promise<void>((resolve) => framed.close(() => resolve()))
    if (tabs) await new Promise<void>((resolve) => tabs.close(() => resolve()))
  })

  test("a page that allows framing shows in the chat, on every device and at full size", { annotation: { type: "summary", description: "ChatApi checks the page first; it allows frames, so it shows in the chat" } }, async ({ devices }) => {
    requires("member", "ownConversation")
    const [a, b] = await devices.open("A", "B")
    const added = viewsAdded(a.device.context)
    const url = allows.url

    await test.step("A sends /web with a page that allows framing", async () => {
      await a.openComposer()
      await a.composer.pressSequentially(`/web ${url}`, typing)
      await a.composer.press("Enter")
    })
    await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
    expect(added[0]).toMatchObject({
      template: "webpage",
      props: { url, ...allows.preview },
    })
    const view = a.page.locator(`[data-view="${added[0]!.id}"]`)

    await test.step("the page shows in its frame, under its origin", async () => {
      await expect(view).toBeVisible({ timeout: 30_000 })
      await expect(view.locator('[data-slot="web-page-origin"]')).toHaveText(new URL(url).origin)
      const frame = view.locator("iframe")
      await expect(frame).toHaveAttribute("src", url)
      await expect(frame).toHaveAttribute("sandbox", SANDBOX)
      await expect(view.locator('[data-slot="web-page-view"]')).toHaveAttribute("data-state", "loaded", { timeout: 30_000 })
      // The page itself, not a browser error: the frame rendered it.
      await expect(view.frameLocator("iframe").locator("h1")).toBeVisible({ timeout: 30_000 })
      await expect(view.frameLocator("iframe").locator("h1")).toHaveText(allows.heading!, { timeout: 30_000 })
      await expect(view.locator('[data-slot="web-link-card"]')).toHaveCount(0)
    })

    await test.step("B shows it from its own synced copy", async () => {
      const synced = b.page.locator(`[data-view="${added[0]!.id}"]`)
      // Frames are lazy. Read the second device's view as a person would, by scrolling it into sight first.
      await synced.scrollIntoViewIfNeeded({ timeout: 30_000 })
      await expect(synced.locator("iframe")).toHaveAttribute("src", url, { timeout: 30_000 })
      await expect(synced.frameLocator("iframe").locator("h1")).toHaveText(allows.heading!, { timeout: 30_000 })
    })

    await test.step("Full screen shows the same page at its own route", async () => {
      await view.getByRole("link", { name: "Full screen" }).click()
      await expect(a.page).toHaveURL(new RegExp(`/app/views/${added[0]!.id}(?:\\?|$)`))
      const full = a.page.getByRole("main", { name: "View" })
      await expect(full.frameLocator("iframe").locator("h1")).toHaveText(allows.heading!, { timeout: 30_000 })
      await full.getByRole("link", { name: "Back to chat" }).click()
      await expect(a.page).toHaveURL(/\/app$/)
    })
  })

  test("a page that refuses framing shows as a card: title, description, domain, icon and Open in new tab, with Enter", { annotation: { type: "summary", description: "The page's framing headers refuse the app, so a card shows instead of a broken frame" } }, async ({ devices }) => {
    requires("member", "ownConversation")
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)
    const url = refuses.url
    const app = a.page.url()

    await test.step("A sends /web with a page that refuses framing", async () => {
      await a.openComposer()
      await a.composer.pressSequentially(`/web ${url}`, typing)
      await a.composer.press("Enter")
    })
    await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
    expect(added[0]).toMatchObject({ template: "link", props: { url, ...refuses.preview } })
    const card = a.page.locator(`[data-view="${added[0]!.id}"] [data-slot="web-link-card"]`)

    await test.step("a card shows what the page is, and no frame", async () => {
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card.locator('[data-slot="web-page-title"]')).toHaveText(refuses.preview.title!)
      await expect(card.locator('[data-slot="web-page-description"]')).toHaveText(
        refuses.preview.description!,
      )
      await expect(card.locator('[data-slot="web-page-domain"]')).toHaveText(new URL(url).host)
      const icon = card.locator('[data-slot="web-page-icon"] img')
      await expect(icon).toHaveAttribute("src", refuses.preview.icon!)
      await expect.poll(() => icon.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
      await expect(a.page.locator(`[data-view="${added[0]!.id}"] iframe`)).toHaveCount(0)
    })

    await test.step("Enter on Open in new tab opens the page in a new tab", async () => {
      const open = card.getByRole("link", { name: `Open in new tab: ${refuses.preview.title}` })
      await expect(open).toHaveAttribute("aria-keyshortcuts", "Enter")
      await expect(open).toHaveAttribute("rel", "noopener noreferrer")
      const opening = a.device.context.waitForEvent("page")
      await open.focus()
      await a.page.keyboard.press("Enter")
      const opened = await opening
      await opened.waitForLoadState()
      expect(opened.url()).toBe(url)
      await expect(opened).toHaveTitle(refuses.documentTitle!)
      await opened.close()
      await expect(a.page).toHaveURL(app)
    })
  })

  test("the agent asked to embed a page that refuses framing adds the card instead", { annotation: { type: "summary", description: "The agent's call checks the page too, and never claims an embed" } }, async ({ devices }) => {
    requires("member", "ownConversation", "liveModel")
    const word = devices.word
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)

    const prompt = `Show me ${refuses.url} in the chat, then reply with the word web-${word}.`
    await a.askAndWaitTaken(prompt)
    await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
    expect(added[0]).toMatchObject({ template: "link", props: { url: refuses.url, ...refuses.preview } })
    const card = a.page.locator(`[data-view="${added[0]!.id}"] [data-slot="web-link-card"]`)
    await expect(card.locator('[data-slot="web-page-title"]')).toHaveText(refuses.preview.title!, { timeout: 30_000 })
    await a.expectAnswered(prompt, `web-${word}`)
  })

  test("the agent's tab card shows the page's domain, and its Open in new tab opens the page", async ({ devices }) => {
    requires("member", "ownConversation", "liveModel")
    const word = devices.word
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)
    const app = a.page.url()

    const prompt = `Open ${tab.url} in a new browser tab, then reply with the word tab-${word}.`
    await a.askAndWaitTaken(prompt)
    await expect.poll(() => added.filter((view) => view.template === "link").length, { timeout: 60_000 }).toBe(1)
    const link = added.find(view => view.template === "link")!
    expect(link).toMatchObject({ template: "link", props: { url: tab.url, ...tab.preview } })
    const card = a.page.locator(`[data-view="${link.id}"]`)
    // This public fixture allows framing: an accidental embed produces a webpage, so cannot pass as a tab card.
    // HTTPS shows the host; a local HTTP page shows its whole origin, including the scheme.
    await expect(card.locator('[data-slot="web-page-domain"]')).toHaveText(new URL(tab.url).protocol === "https:" ? new URL(tab.url).host : new URL(tab.url).origin, { timeout: 30_000 })
    await expect(card.locator('[data-slot="web-page-title"]')).toHaveText(tab.preview.title!)
    await a.expectAnswered(prompt, `tab-${word}`)

    const opening = a.device.context.waitForEvent("page")
    await card.getByRole("link", { name: `Open in new tab: ${tab.preview.title}` }).click()
    const opened = await opening
    await opened.waitForLoadState()
    expect(opened.url()).toBe(tab.url)
    await expect(opened).toHaveTitle(tab.documentTitle!)
    // The app itself stayed where it was.
    await expect(a.page).toHaveURL(app)
  })

  test("a person's /web <url> tab opens the page straight from their Enter, and adds nothing to the chat", async ({ devices }) => {
    requires("member", "ownConversation")
    const [a] = await devices.open("A")
    const added = viewsAdded(a.device.context)
    const outcomes: Array<string> = []
    a.page.on("console", message => {
      if (!message.text().includes("web.page.open")) return
      void wholeText(message).then(text => {
        if (/"web_mode"\s*:\s*"tab"/.test(text) && /"door"\s*:\s*"slash"/.test(text)) {
          const outcome = /"outcome"\s*:\s*"([a-z]+)"/.exec(text)?.[1]
          if (outcome !== undefined) outcomes.push(outcome)
        }
      })
    })
    await a.openComposer()

    const url = target === "local" ? `${local}/from-enter` : tab.url
    const opening = a.device.context.waitForEvent("page")
    await a.composer.pressSequentially(`/web ${url} tab`, typing)
    await a.composer.press("Enter")
    const opened = await opening
    await opened.waitForURL(url)
    expect(opened.url()).toBe(url)
    expect(await opened.evaluate(() => window.opener)).toBeNull()
    expect(await opened.evaluate(() => document.referrer)).toBe("")
    await expect(opened).toHaveTitle(tab.documentTitle!)
    await expect(a.composer).toHaveValue("")
    // The actual gesture receipt closes the action. A delayed fallback card can never satisfy this outcome.
    await expect.poll(() => outcomes).toEqual(["opened"])
    expect(added).toEqual([])
  })

})

test("refusals: a javascript: page, and the app's own origin, stay in the composer saying why; nothing runs", async ({ devices }) => {
  requires("member")
  const [a] = await devices.open("A")
  const added = viewsAdded(a.device.context)
  const dialogs: Array<string> = []
  a.page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  const status = a.composerForm.locator(".sui-chat-composer-status")
  await a.openComposer()

  await a.composer.pressSequentially("/web javascript:alert(document.cookie)", typing)
  await a.composer.press("Enter")
  await expect(status).toHaveText(CANT_OPEN.scheme)
  await expect(a.composer).toHaveValue("/web javascript:alert(document.cookie)")

  // The app's own host: a frame of it would hand it the app, and a tab of it is /navigate's. Its plain-HTTP form is
  // refused first, whichever the app is served over.
  const app = new URL(a.page.url()).origin
  await a.composer.fill("")
  await a.composer.pressSequentially(`/web ${app.replace(/^http:/, "https:")}/app`, typing)
  await a.composer.press("Enter")
  await expect(status).toHaveText(CANT_OPEN.same_origin)
  await a.composer.fill("")
  await a.composer.pressSequentially(`/web ${app.replace(/^https:/, "http:")}/app`, typing)
  await a.composer.press("Enter")
  await expect(status).toHaveText(CANT_OPEN.insecure)

  expect(added).toEqual([])
  expect(dialogs).toEqual([])
  await expect(a.page).toHaveURL(/\/app$/)
})

test("the app's own pages refuse to be framed, and frame nothing but https pages", async ({ request, devices }) => {
  const response = await request.get("/app")
  expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'")
  expect(response.headers()["x-frame-options"]).toBe("DENY")
  const [a] = await devices.open("A")
  await expect(a.page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", "frame-src https:")
})
