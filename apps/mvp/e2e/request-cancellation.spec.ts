import { writeFile } from "node:fs/promises"
import { expect, test } from "./fixtures"
import { persistent } from "./persistent"
import { requires, target } from "./target"

requires("member")

test("navigation cancels WebKit's old page live read without a server or access-control failure", async ({ playwright, context, baseURL, problems }, testInfo) => {
  const device = await persistent(playwright.webkit, {
    baseURL, ignoreHTTPSErrors: testInfo.project.use.ignoreHTTPSErrors,
    recordVideo: { dir: testInfo.outputPath("webkit"), size: { width: 1280, height: 800 } },
  })
  problems.watch(device.context)
  try {
    await device.context.addCookies((await context.storageState()).cookies)
    const first = await device.context.request.get("/api/shapes/flows?offset=-1")
    expect(first.ok()).toBe(true)
    const headers = first.headers()
    expect(headers["electric-handle"]).toBeTruthy()
    expect(headers["electric-offset"]).toBeTruthy()
    const query = new URLSearchParams({ handle: headers["electric-handle"]!, offset: headers["electric-offset"]!, live: "true", cursor: "" })
    // The first live response establishes the server's cursor. An empty cursor may answer immediately.
    const live = await device.context.request.get(`/api/shapes/flows?${query}`)
    expect([200, 204]).toContain(live.status())
    const cursor = live.headers()["electric-cursor"]
    expect(cursor).toBeTruthy()
    query.set("cursor", cursor!)
    const page = await device.context.newPage()
    await page.goto("/app/flows")
    await expect(page.getByRole("heading", { name: "Flows", exact: true })).toBeVisible({ timeout: 30_000 })
    // Exporters reuse a URL. A successful earlier batch is independent of the attempt WebKit refuses before
    // dispatch while leaving this document. No telemetry content or persistent product state is written here.
    expect(await page.evaluate(async () => (await fetch("/api/telemetry/v1/logs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceLogs: [] }),
    })).status)).toBe(200)
    const address = new URL(`/api/shapes/flows?${query}`, page.url()).href
    const failed: string[] = []
    page.on("requestfailed", request => {
      if (request.url() === address) failed.push(request.failure()?.errorText ?? "")
    })
    const started = page.waitForRequest(request => request.url() === address)
    await page.evaluate(url => {
      // The old document handles rejection; leaving it deliberately cancels its live poll.
      void fetch(url).then(response => response.text()).catch(() => {
        // WebKit handles this rejection on the outgoing document before pagehide and before network dispatch.
        void fetch("/api/telemetry/v1/logs", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceLogs: [] }),
        }).catch(() => undefined)
      })
    }, address)
    await started
    await page.goto("/app/flows/new")
    await expect(page.getByRole("heading", { name: "New flow", exact: true })).toBeVisible({ timeout: 30_000 })
    expect(failed).toEqual(["cancelled"])
    const receipts = problems.navigationCancellations()
    // The compiled bootstrap reproduces WebKit's pre-dispatch refusal; Vite's module loading can finish quietly.
    // Production must exercise the native diagnostic, beyond a dispatched cancellation any watcher already permits.
    if (target === "deployment") expect(receipts.some(receipt => receipt.includes("/api/telemetry/v1/logs"))).toBe(true)
    const path = testInfo.outputPath("navigation-cancellations.json")
    await writeFile(path, JSON.stringify({ failed, receipts }, null, 2))
    await testInfo.attach("navigation-cancellations", { path, contentType: "application/json" })
  } finally {
    await device.close()
  }
})
