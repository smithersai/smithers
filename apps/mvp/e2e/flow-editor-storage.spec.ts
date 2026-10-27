import { expectConsoleError } from "./watch"
import { expect, test } from "./fixtures"
import { requires } from "./target"
import { routeTemplate } from "../src/apiRoutes"

requires("member")

test.afterEach(async ({ page, browserLog }, testInfo) => {
  const capabilities = await page.evaluate(async () => {
    let directory: string
    try { await navigator.storage.getDirectory(); directory = "available" } catch (error) { directory = error instanceof Error ? error.name : "unavailable" }
    const session = await fetch("/api/auth/session").then(async response => {
      const value = await response.json()
      return { status: response.status, signedIn: value.signedIn, role: value.role, hasModel: value.hasModel, hostedModel: value.hostedModel }
    }).catch(error => ({ error: error instanceof Error ? error.name : "unavailable" }))
    return { directory, persisted: await navigator.storage.persisted(), session }
  }).catch(() => ({ closed: true }))
  const storageLog = browserLog.filter(line => /flows\.editor\.storage|browser\.(engine|runtime)|persistence unavailable|auth\.device_identity/.test(line))
  await testInfo.attach("storage-receipts", { body: JSON.stringify({ capabilities, storageLog }, null, 2), contentType: "application/json" })
})

// The shared page fixture supplies a new persistent WebKit profile (persistent.ts),
// records the page and checks every error before intentionally closing the device.
// Chromium's fresh context supports the same OPFS API without asking persist().
test("a fresh device edits a new flow without persistent storage permission", async ({ page, browserLog }) => {
  page.on("requestfailed", (request) => browserLog.push(`storage request ${Date.now()} ${request.method()} ${routeTemplate(new URL(request.url()).pathname)} ${request.failure()?.errorText}`))
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) browserLog.push(`storage document ${Date.now()}`)
  })
  await page.goto("/app/flows")
  await page.getByRole("link", { name: "New flow", exact: true }).click()
  await expect(page.getByRole("heading", { name: "New flow", exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.storage.persisted())).toBe(false)
  await page.getByLabel("Name", { exact: true }).fill("bugbash4-w13f-storage-draft")
  await page.getByLabel("What it should do", { exact: true }).fill("Retain this unfinished request")
  await expect(page.getByRole("button", { name: "Draft", exact: true })).toBeEnabled()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bugbash4-w13f-storage-draft")
  await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Retain this unfinished request")
  expect(await page.evaluate(() => navigator.storage.persisted())).toBe(false)
  browserLog.push(`storage reload requested ${Date.now()}`)
  await page.reload()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bugbash4-w13f-storage-draft")
  await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Retain this unfinished request")
  browserLog.push(`storage reopen requested ${Date.now()}`)
  await page.goto("/app/flows/new")
  await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Retain this unfinished request")
})

const privateTest = test.extend({
  context: async ({ playwright, context, baseURL, ignoreHTTPSErrors }, use, testInfo) => {
    const browser = await playwright.webkit.launch()
    const privateContext = await browser.newContext({ baseURL, ignoreHTTPSErrors,
      storageState: await context.storageState(), viewport: { width: 1280, height: 800 },
      recordVideo: { dir: testInfo.outputPath("private-webkit"), size: { width: 1280, height: 800 } },
    })
    try {
      await use(privateContext)
    } finally {
      const saved = privateContext.pages().map((page, index) =>
        page.video()?.saveAs(testInfo.outputPath(index === 0 ? "video.webm" : `video-${index}.webm`)))
      try {
        await privateContext.close()
        await Promise.all(saved)
      } finally {
        await browser.close()
      }
    }
  },
})

privateTest("private WebKit keeps the editor usable for this session", async ({ page }) => {
  expectConsoleError("browser.runtime.stopped")
  expectConsoleError("browser.engine.unavailable")
  await page.goto("/app/flows/new")
  await page.getByLabel("Name", { exact: true }).fill("bugbash4-w13f-session-draft")
  await page.getByLabel("What it should do", { exact: true }).fill("Keep editing in this session")
  await expect(page.getByRole("button", { name: "Draft", exact: true })).toBeEnabled()
  await expect(page.getByText("Not kept on this device", { exact: true })).toBeVisible()
  await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Keep editing in this session")
})

test("the device precaches a valid engine binary before offline reopening", async ({ page }) => {
  await page.goto("/app/flows/new")
  await page.getByLabel("Name", { exact: true }).waitFor()
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  const valid = await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) {
        if (!/\/wa-sqlite-[^/]+\.wasm$/.test(new URL(request.url).pathname)) continue
        const response = await cache.match(request)
        if (response !== undefined && WebAssembly.validate(await response.arrayBuffer())) return true
      }
    }
    return false
  })
  expect(valid).toBe(true)
})
