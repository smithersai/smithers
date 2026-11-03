import { chromium } from "@playwright/test"
import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { expect, test } from "vitest"
import { Watched } from "./watch"

// Real HTTP and browser events: error headers arrive before the body; another failure arrives during teardown.
test("the problem log collects a later error body during teardown and bounds one that never ends", async () => {
  const responses = new Map<string, ServerResponse>()
  const server = createServer((request, response) => {
    if (!request.url?.startsWith("/api/failure/")) {
      response.writeHead(200, { "content-type": "text/html" }).end("<title>Diagnostics</title>")
      return
    }
    responses.set(request.url, response)
    response.writeHead(503, { "content-type": "application/json", "x-smithers-ray": request.url.endsWith("first") ? "0123456789abcdef-SJC" : "fedcba9876543210-SJC" })
    response.write('{"code":')
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing test address")
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const watched = new Watched(origin)
    watched.watch(context)
    const page = await context.newPage()
    await page.goto(origin)
    const start = async (name: string) => {
      const received = page.waitForResponse(`${origin}/api/failure/${name}`)
      await page.evaluate(name => { void fetch(`/api/failure/${name}`).then(response => response.text()).catch(() => {}) }, name)
      await received
    }
    await start("first")
    const log: string[] = []
    const checking = watched.check({ annotations: [] }, log)
    await start("second")
    responses.get("/api/failure/first")!.end('"github_unavailable","message":"PRIVATE_BODY"}')
    // The first body is complete, but the second remains in flight across a real browser turn.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))))
    responses.get("/api/failure/second")!.end('"unavailable","token":"PRIVATE_TOKEN"}')
    expect(await checking).toEqual([
      "503 GET /api/failure/first code=github_unavailable x-smithers-ray=0123456789abcdef-SJC ×1",
      "503 GET /api/failure/second code=unavailable x-smithers-ray=fedcba9876543210-SJC ×1",
    ])
    expect(log.join("\n")).not.toMatch(/PRIVATE_BODY|PRIVATE_TOKEN/)
    await start("stuck")
    const bounded = await watched.check({ annotations: [] }, [])
    expect(bounded).toContain("503 GET /api/failure/stuck code=unknown x-smithers-ray=fedcba9876543210-SJC ×1")
  } finally {
    await browser.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 15_000)
