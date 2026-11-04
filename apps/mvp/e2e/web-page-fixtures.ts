import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { request as requests, type BrowserContext, type Request } from "@playwright/test"
import { WebPage } from "@smthrs/views"
import { certificate } from "../dev/https.ts"
import { VIEWS_ROUTE } from "../src/features/views/contract"
import { WEB_PREVIEW_ROUTE } from "../src/features/web/contract"
import { expect, test } from "./devices"
import { redactRequestErrors } from "./redact"
import { baseURL, requires, target, writeHeaders, sessionFiles } from "./target"

// Web pages, end to end (docs/features/web-pages.md): the real app, its engine worker, ChatApi, Electric and, for the
// agent's cases, the real model. Before a page is framed, ChatApi requests it from the server and reads its framing
// headers: a page that allows it shows in the chat, one that refuses shows as a card with its title, description,
// domain and icon. A person's own `/web` opens a tab straight from their keypress; a page the app won't open stays in the
// composer saying why. A view is a conversation row, so a second device shows it too.
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
export const viewsAdded = (context: BrowserContext) => {
  const added: Array<{ readonly id: string; readonly template: string; readonly props: Record<string, string> }> = []
  context.on("request", (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === VIEWS_ROUTE) added.push(request.postDataJSON())
  })
  return added
}

export const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"

/** Typing a person can follow in the video. */
export const typing = { delay: 30 }

export const webPages = () => ({ allows, refuses, tab, local })

/** Register inside the describe that needs real external pages; URL/CSP refusals need no fixture. */
export const installWebPages = () => {
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

}
