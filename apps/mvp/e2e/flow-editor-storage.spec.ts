import { expectConsoleError } from "./watch"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member")

for (const browserName of ["chromium", "webkit"] as const) {
  test.describe(`flow editor storage: ${browserName}`, () => {
    test("a fresh device edits a new flow without persistent storage permission", async ({ playwright, context, baseURL, problems }, testInfo) => {
      const session = await context.storageState()
      const profile = await mkdtemp(join(tmpdir(), "flow-editor-storage-"))
      const fresh = await playwright[browserName].launchPersistentContext(profile, { baseURL, ignoreHTTPSErrors: testInfo.project.use.ignoreHTTPSErrors, recordVideo: { dir: testInfo.outputPath(browserName), size: { width: 1280, height: 800 } } })
      await fresh.addCookies(session.cookies)
      problems.watch(fresh)
      try {
        const page = await fresh.newPage()
        await page.goto("/app/flows")
        await page.getByRole("link", { name: "New flow", exact: true }).click()
        await expect(page.getByRole("heading", { name: "New flow", exact: true })).toBeVisible()
        expect(await page.evaluate(() => navigator.storage.persisted())).toBe(false)
        await page.getByLabel("Name", { exact: true }).fill("bugbash3-bb2-flows-storage-draft")
        await page.getByLabel("What it should do", { exact: true }).fill("Retain this unfinished request")
        await expect(page.getByRole("button", { name: "Draft", exact: true })).toBeEnabled()
        await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bugbash3-bb2-flows-storage-draft")
        await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Retain this unfinished request")
        expect(await page.evaluate(() => navigator.storage.persisted())).toBe(false)
        await page.reload()
        await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bugbash3-bb2-flows-storage-draft")
        await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Retain this unfinished request")
        await page.goto("/app/flows/new")
        await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Retain this unfinished request")
      } finally {
        await fresh.close()
        await rm(profile, { recursive: true, force: true })
      }
    })
  })
}

test("private WebKit keeps the editor usable for this session", async ({ playwright, context, baseURL, problems }, testInfo) => {
  expectConsoleError("browser.runtime.stopped")
  expectConsoleError("browser.engine.unavailable")
  const browser = await playwright.webkit.launch()
  const privateContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: testInfo.project.use.ignoreHTTPSErrors, storageState: await context.storageState() })
  problems.watch(privateContext)
  try {
    const page = await privateContext.newPage()
    await page.goto("/app/flows/new")
    await page.getByLabel("Name", { exact: true }).fill("session-draft")
    await page.getByLabel("What it should do", { exact: true }).fill("Keep editing in this session")
    await expect(page.getByRole("button", { name: "Draft", exact: true })).toBeEnabled()
    await expect(page.getByText("Not kept on this device", { exact: true })).toBeVisible()
    await expect(page.getByLabel("What it should do", { exact: true })).toHaveValue("Keep editing in this session")
  } finally {
    await browser.close()
  }
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
