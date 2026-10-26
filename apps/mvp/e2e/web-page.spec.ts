import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import type { BrowserContext, Request } from "@playwright/test"
import { certificate } from "../dev/https.ts"
import { VIEWS_ROUTE } from "../src/features/views/contract"
import { CANT_OPEN } from "../src/features/web/contract"
import { expect, test } from "./devices"
import { meets, requires } from "./target"

// Web pages, end to end (docs/features/web-pages.md): the real app, its engine worker, ChatApi, Electric and, for the
// agent's cases, the real model. Before a page is framed, ChatApi requests it from the server and reads its framing
// headers: a page that allows it shows in the chat, one that refuses shows as a card with its title, description,
// domain and icon. A person's own `/web` opens a tab straight from their keypress; a page the app won't open stays in the
// composer saying why. A view is a conversation row, so a second device shows it too. The agent's cases are few and
// short: Cerebras rate-limits calls.
//
// The pages are this test's own, never an outside site: an HTTPS server on 127.0.0.1, another site than the app's
// `localhost`, over the dev certificate the dev Worker trusts (docs/infrastructure.md#https-and-http2), and an HTTP
// server on `localhost` for new tabs, which `alchemy dev` alone opens. A deployment can't reach either, so the tests that
// use them run locally only (`requires("localServer")`, e2e/target.ts); the rest run everywhere.

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
test.beforeAll(async () => {
  if (!meets("localServer")) return
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
})
test.afterAll(async () => {
  if (!meets("localServer")) return
  await new Promise<void>((resolve) => framed.close(() => resolve()))
  await new Promise<void>((resolve) => tabs.close(() => resolve()))
})

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

test("a page that allows framing shows in the chat, on every device and at full size", { annotation: { type: "summary", description: "ChatApi checks the page first; it allows frames, so it shows in the chat" } }, async ({ devices }) => {
  requires("localServer")
  const [a, b] = await devices.open("A", "B")
  const added = viewsAdded(a.device.context)
  const url = `${pages}/allows`

  await test.step("A sends /web with a page that allows framing", async () => {
    await a.openComposer()
    await a.composer.pressSequentially(`/web ${url}`, typing)
    await a.composer.press("Enter")
  })
  await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
  expect(added[0]).toMatchObject({
    template: "webpage",
    props: { url, title: "Frames welcome", description: "A test page that lets the app frame it.", icon: `${pages}/icon.svg` },
  })
  const view = a.page.locator(`[data-view="${added[0]!.id}"]`)

  await test.step("the page shows in its frame, under its origin", async () => {
    await expect(view).toBeVisible({ timeout: 30_000 })
    await expect(view.locator('[data-slot="web-page-origin"]')).toHaveText(pages)
    const frame = view.locator("iframe")
    await expect(frame).toHaveAttribute("src", url)
    await expect(frame).toHaveAttribute("sandbox", SANDBOX)
    await expect(view.locator('[data-slot="web-page-view"]')).toHaveAttribute("data-state", "loaded", { timeout: 30_000 })
    // The page itself, not a browser error: the frame rendered it.
    await expect(view.frameLocator("iframe").locator("h1")).toHaveText("Frames welcome", { timeout: 30_000 })
    await expect(view.locator('[data-slot="web-link-card"]')).toHaveCount(0)
  })

  await test.step("B shows it from its own synced copy", async () => {
    await expect(b.page.locator(`[data-view="${added[0]!.id}"] iframe`)).toHaveAttribute("src", url, { timeout: 30_000 })
  })

  await test.step("Full screen shows the same page at its own route", async () => {
    await view.getByRole("link", { name: "Full screen" }).click()
    await expect(a.page).toHaveURL(new RegExp(`/app/views/${added[0]!.id}$`))
    const full = a.page.getByRole("main", { name: "View" })
    await expect(full.frameLocator("iframe").locator("h1")).toHaveText("Frames welcome", { timeout: 30_000 })
    await full.getByRole("link", { name: "Back to chat" }).click()
    await expect(a.page).toHaveURL(/\/app$/)
  })
})

test("a page that refuses framing shows as a card: title, description, domain, icon and Open in new tab, with Enter", { annotation: { type: "summary", description: "The page sends X-Frame-Options: DENY, so a card shows instead of a broken frame" } }, async ({ devices }) => {
  requires("localServer")
  const [a] = await devices.open("A")
  const added = viewsAdded(a.device.context)
  const url = `${pages}/refuses`

  await test.step("A sends /web with a page that refuses framing", async () => {
    await a.openComposer()
    await a.composer.pressSequentially(`/web ${url}`, typing)
    await a.composer.press("Enter")
  })
  await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
  expect(added[0]).toMatchObject({ template: "link", props: { url, title: "Frames refused" } })
  const card = a.page.locator(`[data-view="${added[0]!.id}"] [data-slot="web-link-card"]`)

  await test.step("a card shows what the page is, and no frame", async () => {
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('[data-slot="web-page-title"]')).toHaveText("Frames refused")
    await expect(card.locator('[data-slot="web-page-description"]')).toHaveText(
      "A test page that refuses every frame, as many real sites do.",
    )
    await expect(card.locator('[data-slot="web-page-domain"]')).toHaveText(new URL(pages).host)
    await expect(card.locator('[data-slot="web-page-icon"] img')).toHaveAttribute("src", `${pages}/icon.svg`)
    await expect(a.page.locator(`[data-view="${added[0]!.id}"] iframe`)).toHaveCount(0)
  })

  await test.step("Enter on Open in new tab opens the page in a new tab", async () => {
    const open = card.getByRole("link", { name: "Open in new tab: Frames refused" })
    await expect(open).toHaveAttribute("aria-keyshortcuts", "Enter")
    await expect(open).toHaveAttribute("rel", "noopener noreferrer")
    const opening = a.device.context.waitForEvent("page")
    await open.focus()
    await a.page.keyboard.press("Enter")
    const opened = await opening
    await opened.waitForLoadState()
    expect(opened.url()).toBe(url)
    await expect(opened).toHaveTitle("Frames refused")
    await opened.close()
    await expect(a.page).toHaveURL(/\/app$/)
  })
})

test("the agent asked to embed a page that refuses framing adds the card instead", { annotation: { type: "summary", description: "The agent's call checks the page too, and never claims an embed" } }, async ({ devices }) => {
  requires("localServer", "liveModel")
  const word = devices.word
  const [a] = await devices.open("A")
  const added = viewsAdded(a.device.context)

  await a.askAndWaitTaken(`Show me ${pages}/refuses in the chat, then reply with the word web-${word}.`)
  await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
  expect(added[0]).toMatchObject({ template: "link", props: { url: `${pages}/refuses`, title: "Frames refused" } })
  const card = a.page.locator(`[data-view="${added[0]!.id}"] [data-slot="web-link-card"]`)
  await expect(card.locator('[data-slot="web-page-title"]')).toHaveText("Frames refused", { timeout: 30_000 })
})

test("the agent's tab card shows the page's domain, and its Open in new tab opens the page", async ({ devices }) => {
  requires("localServer", "liveModel")
  const word = devices.word
  const [a] = await devices.open("A")
  const added = viewsAdded(a.device.context)

  await a.askAndWaitTaken(`Open ${local}/ in a new browser tab, then reply with the word tab-${word}.`)
  await expect.poll(() => added.filter((view) => view.template === "link").length, { timeout: 60_000 }).toBe(1)
  const card = a.page.locator(`[data-view="${added.find((view) => view.template === "link")!.id}"]`)
  // An http page shows its whole origin, so its scheme shows.
  await expect(card.locator('[data-slot="web-page-domain"]')).toHaveText(local, { timeout: 30_000 })
  await expect(card.locator('[data-slot="web-page-title"]')).toHaveText("Local test page")

  const opening = a.device.context.waitForEvent("page")
  await card.getByRole("link", { name: "Open in new tab: Local test page" }).click()
  const opened = await opening
  await opened.waitForLoadState()
  expect(opened.url()).toBe(`${local}/`)
  await expect(opened).toHaveTitle("Local test page")
  // The app itself stayed where it was.
  await expect(a.page).toHaveURL(/\/app$/)
})

test("a person's /web <url> tab opens the page straight from their Enter, and adds nothing to the chat", async ({ devices }) => {
  requires("localServer")
  const [a] = await devices.open("A")
  const added = viewsAdded(a.device.context)
  await a.openComposer()

  const opening = a.device.context.waitForEvent("page")
  await a.composer.pressSequentially(`/web ${local}/from-enter tab`, typing)
  await a.composer.press("Enter")
  const opened = await opening
  await opened.waitForLoadState()
  expect(opened.url()).toBe(`${local}/from-enter`)
  await expect(a.composer).toHaveValue("")
  expect(added).toEqual([])
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
