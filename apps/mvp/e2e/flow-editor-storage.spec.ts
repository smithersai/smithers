import { expectConsoleError, expectServerError } from "./watch"
import { expect, test } from "./fixtures"
import { baseURL as targetURL, onThisMachine, requires } from "./target"
import { routeTemplate } from "../src/apiRoutes"
import { offlineTransport, type OfflineTransport } from "./offlineTransport"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { serveBuilds } from "./builds"

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

// WebKit's setOffline blocks even service-worker navigations. Cut real sockets instead;
// both browsers must reopen the editor and its engine from the device's own caches.
const OFFLINE_HOST = "smithers.test"
const offlineTest = test.extend<{ builtURL: string; transport: OfflineTransport | undefined }>({
  builtURL: [async ({}, use) => {
    if (!onThisMachine(targetURL)) return use(targetURL)
    // Reuse the release-test host: real built assets, with /api on the real ChatApi.
    const directory = await mkdtemp(join(tmpdir(), "pwa-engine-"))
    try {
      await build({ root: join(import.meta.dirname, ".."), logLevel: "error", build: { outDir: directory, emptyOutDir: true } })
      const front = await serveBuilds({ old: directory })
      try { await use(front.url.href) } finally { await front.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, { timeout: 300_000 }],
  baseURL: async ({ builtURL, browserName }, use) => {
    // macOS CFNetwork bypasses proxies for localhost (Playwright #20328).
    // A reserved hostname reaches the same real server through the relay.
    if (browserName !== "webkit" || !onThisMachine(builtURL)) return use(builtURL)
    const url = new URL(builtURL)
    url.hostname = OFFLINE_HOST
    await use(url.href)
  },
  transport: async ({ baseURL, browserName }, use) => {
    if (browserName !== "webkit") return use(undefined)
    const original = new URL(targetURL)
    const selected = new URL(baseURL ?? targetURL)
    const transport = await offlineTransport({ hosts: selected.hostname === OFFLINE_HOST ? { [OFFLINE_HOST]: original.hostname } : {} })
    try { await use(transport) } finally { await transport.close() }
  },
  contextOptions: async ({ contextOptions, transport }, use) => use(transport === undefined ? contextOptions : { ...contextOptions, proxy: transport.proxy }),
})

offlineTest("the device caches a valid engine binary and reopens offline", async ({ page, context, browserLog, transport }) => {
  await page.goto("/app/flows/new")
  await page.getByLabel("Name", { exact: true }).waitFor()
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await page.getByLabel("Name", { exact: true }).fill("offline-engine-draft")
  await expect.poll(() => browserLog.some(line => line.includes("flows.editor.storage") && line.includes("flow-form") && line.includes("restored")), {
    message: "the editor restored its persistent form", timeout: 30_000,
  }).toBe(true)
  const validEngine = () => page.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith("workbox-precache")) continue
      const cache = await caches.open(name)
      for (const request of await cache.keys()) {
        if (!/\/wa-sqlite-[^/]+\.wasm$/.test(new URL(request.url).pathname)) continue
        const response = await cache.match(request)
        if (response?.ok && WebAssembly.validate(await response.arrayBuffer())) return true
      }
    }
    return false
  })
  await expect.poll(validEngine, { message: "a completed valid WASM cache receipt", timeout: 30_000 }).toBe(true)
  expectConsoleError("WebSocket connection to")
  const offlineFrom = browserLog.length
  if (transport === undefined) await context.setOffline(true)
  else {
    expectServerError("failed", "/api/*")
    expectConsoleError("kCFErrorDomainCFNetwork error 310.")
    expect(transport.forwarded(), "the device uses the real transport relay").toBeGreaterThan(0)
    transport.disconnect()
  }
  try {
    expect(await page.evaluate(() => fetch("/api/auth/session", { cache: "no-store" }).then(() => false, () => true)),
      "the origin is unreachable through the cut relay").toBe(true)
    await page.reload()
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("offline-engine-draft")
    await expect(page.getByText("Not kept on this device", { exact: true })).toHaveCount(0)
    await page.getByLabel("What it should do", { exact: true }).fill("Edit after an offline reopen")
    await expect(page.getByRole("button", { name: "Draft", exact: true })).toBeEnabled()
    await expect.poll(() => browserLog.slice(offlineFrom).some(line => line.includes("flows.editor.storage") && line.includes("flow-form") && line.includes("restored")), {
      message: "the editor restored its persistent form offline", timeout: 30_000,
    }).toBe(true)
    expect(await validEngine()).toBe(true)
  } finally {
    if (transport === undefined) await context.setOffline(false)
    else transport.reconnect()
  }
})
