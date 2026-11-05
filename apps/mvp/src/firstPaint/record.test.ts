// Native browser, Web Locks, MutationObserver and HTTP: the actual inline shell and first-paint response contract.
// A failed read is an injected Effect service, never a routed or mocked browser response.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright"
import { Context, Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/http"
import { afterAll, beforeAll, expect, test } from "vitest"
import { guarded, painted } from "../../worker/github/FirstPaint"

class PaintRead extends Context.Service<PaintRead, { readonly read: Effect.Effect<HttpServerResponse.HttpServerResponse, Error> }>()("first-paint-test/Read") {}
const issue = { number: 7, title: "An issue", state: "open", author: null }
const readable = Layer.succeed(PaintRead, { read: Effect.succeed(painted({ viewer: null, serverNow: 0, issue })) })
const failed = Layer.succeed(PaintRead, { read: Effect.fail(new Error("read refused")) })
let server: Server
let browser: Browser
let origin: string

beforeAll(async () => {
  const bundle = await build({ entryPoints: ["src/firstPaint/inline.ts"], bundle: true, write: false, format: "iife", platform: "browser" })
  const script = bundle.outputFiles[0]!.text
  server = createServer((request, response) => {
    if (!request.url!.startsWith("/api/")) {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(`<script>${script}</script><div id="root"></div>`)
      return
    }
    const layer = request.url!.includes("issue=8") ? failed : readable
    void Effect.runPromise(guarded(() => Effect.flatMap(PaintRead, (service) => service.read), {}, () => "ReadRefused").pipe(Effect.provide(layer)))
      .then(HttpServerResponse.toWeb)
      .then(async (answer) => {
        response.writeHead(answer.status, Object.fromEntries(answer.headers))
        response.end(new Uint8Array(await answer.arrayBuffer()))
      })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

const records = (page: Page) => page.evaluate(() => performance.getEntriesByType("mark")
  .filter((entry) => entry.name.startsWith("smithers.first_paint."))
  .map((entry) => ({ name: entry.name, detail: (entry as PerformanceMark).detail })))

test("navigation records one outcome before removing the node, even when removal reenters revocation", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/acme/app/issues/7`)
    await page.waitForSelector("#first-paint")
    // A real custom element's disconnect reaction runs synchronously inside node.remove().
    const observed = await page.evaluate(() => {
      const shell = (window as unknown as { __smithersFirstPaint: { routed: (path: string, search: string) => void; revoke: () => void } }).__smithersFirstPaint
      let atRemoval = -1
      customElements.define("paint-removal", class extends HTMLElement {
        disconnectedCallback() {
          atRemoval = performance.getEntriesByName("smithers.first_paint.navigated").length
          shell.revoke()
        }
      })
      document.getElementById("first-paint")!.append(document.createElement("paint-removal"))
      shell.routed("/acme/app/issues", "")
      shell.revoke()
      return atRemoval
    })
    expect(observed).toBe(1)
    expect(await records(page)).toEqual([
      { name: "smithers.first_paint.painted", detail: null },
      { name: "smithers.first_paint.navigated", detail: { previous: "painted", trigger: "router", connected: true } },
    ])
    expect(await page.locator("#first-paint").count()).toBe(0)
  } finally { await page.close() }
})

test("a page replacing its placed slot records the detached hand-over once", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/acme/app/issues/7`)
    await page.waitForSelector("#first-paint")
    await page.evaluate(() => { document.getElementById("root")!.innerHTML = '<main><div data-first-paint-slot></div></main>' })
    await page.waitForSelector("#root #first-paint")
    await page.evaluate(() => { document.getElementById("root")!.innerHTML = "<main><h1>An issue #7</h1></main>" })
    expect(await records(page)).toEqual([
      { name: "smithers.first_paint.painted", detail: null },
      { name: "smithers.first_paint.handed_over", detail: { previous: "painted", trigger: "dom", connected: false } },
    ])
    expect(await page.locator("#first-paint").count()).toBe(0)
  } finally { await page.close() }
})

test("a refused read records none from pending; navigation cannot invent a paint or second outcome", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/acme/app/issues/8`)
    await page.waitForFunction(() => performance.getEntriesByName("smithers.first_paint.none").length === 1)
    await page.evaluate(() => {
      const shell = (window as unknown as { __smithersFirstPaint: { routed: (path: string, search: string) => void } }).__smithersFirstPaint
      document.getElementById("root")!.innerHTML = "<main><h1>The early issue read #8</h1></main>"
      shell.routed("/acme/app/issues", "")
    })
    expect(await records(page)).toEqual([
      { name: "smithers.first_paint.none", detail: { previous: "pending", trigger: "response", connected: false } },
    ])
    expect(await page.locator("#first-paint").count()).toBe(0)
  } finally { await page.close() }
})
