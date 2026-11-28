import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { serveBuilds, serveSiteBuilds } from "./builds"
import { expect, step, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

test.use({ serviceWorkers: "allow" })

test("release: an open tab discovers a second production build on navigation and moves to it once hidden, never under a click", {
  annotation: { type: "summary", description: "A deploy reaches an open tab without reloading it under a click; the tab moves once hidden." },
}, async ({ page }) => {
  requires("localServer")
  const checks: string[] = []
  const lines: string[] = []
  page.on("console", (message) => {
    lines.push(message.text())
    if (message.text().startsWith("pwa.update.check")) checks.push(message.text())
  })
  let documents = 0
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++
  })
  test.setTimeout(300_000)
  const root = join(import.meta.dirname, "..")
  const directory = await mkdtemp(join(tmpdir(), "pwa-release-"))
  try {
    for (const version of ["old", "new"]) {
      await build({ root, logLevel: "error", build: { outDir: join(directory, version), emptyOutDir: true },
        plugins: [{ name: "release-marker", transformIndexHtml: (html) => html.replace("<head>", `<head><meta name="release-test" content="${version}">`) }],
      })
    }
    const builds = await serveBuilds({ old: join(directory, "old"), new: join(directory, "new") })
    try {
      await step("Open the first release with its service worker", async () => {
        await page.goto(`${builds.url}/app`)
        await expect(page.getByRole("main", { name: "App", exact: true })).toBeVisible({ timeout: 60_000 })
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready
          if (navigator.serviceWorker.controller) return
          await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }))
        })
        await expect(page.locator('meta[name="release-test"]')).toHaveAttribute("content", "old")
      })
      // This case covers a route the old client can still render. The separate cold-import case covers a removed chunk.
      await page.getByRole("link", { name: "Flows", exact: true }).click()
      await page.waitForURL("**/app/flows")
      await page.goBack()
      await expect(page.getByRole("main", { name: "App", exact: true })).toBeVisible()
      await step("Deploy a release while this tab stays open", async () => {
        builds.use("new")
        await expect(page.locator('meta[name="release-test"]')).toHaveAttribute("content", "old")
      })
      await step("Navigate in the app: the new release activates and the page stays as it is", async () => {
        const changed = page.evaluate(() =>
          new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })))
        const before = documents
        // A real router link: no manual registration.update(), reload or document navigation.
        await page.getByRole("link", { name: "Flows", exact: true }).click()
        await changed
        expect(checks.some((record) => record.includes("navigation"))).toBe(true)
        // Five seconds after the release took over the tab, the click's page is still the old release's, not reloaded.
        await Effect.runPromise(Effect.sleep(5_000))
        await expect(page.locator('meta[name="release-test"]')).toHaveAttribute("content", "old")
        expect(documents).toBe(before)
        expect(lines.some((line) => line.startsWith("page.reload"))).toBe(false)
      })
      await step("Leave the tab: hidden, it reloads into the new release and says why", async () => {
        // Headless Chromium keeps every page visible, so the page is told it was hidden the way a browser tells it.
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
          document.dispatchEvent(new Event("visibilitychange"))
        })
        await expect(page.locator('meta[name="release-test"]')).toHaveAttribute("content", "new", { timeout: 30_000 })
        expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
        expect(lines.some((line) => line.startsWith("page.reload") && line.includes("pwa_update"))).toBe(true)
        await expect.poll(() => lines.some((line) => line.includes("page reloaded") && line.includes("pwa_update")), { timeout: 30_000 }).toBe(true)
      })
      // Leave the release before its server stops, so the reloaded page's own requests don't fail mid-flight.
      await page.goto("about:blank")
    } finally { await builds.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("a route import lost before a new worker activates recovers once through the new shell", async ({ page, browser }) => {
  requires("localServer")
  test.setTimeout(300_000)
  const root = join(import.meta.dirname, "..")
  const directory = await mkdtemp(join(tmpdir(), "pwa-import-"))
  const records: string[] = []
  const hashedAssets: Array<{ readonly path: string; readonly cacheControl: string | undefined; readonly contentType: string | undefined }> = []
  page.on("console", (message) => {
    if (message.text().startsWith("page.reload")) records.push(message.text())
  })
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname
    if (response.status() === 200 && /^\/assets\/[^/]+\.(?:js|css)$/.test(pathname)) {
      const headers = response.headers()
      hashedAssets.push({ path: pathname, cacheControl: headers["cache-control"], contentType: headers["content-type"] })
    }
  })
  let documents = 0
  page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++ })
  let activate!: () => void
  const beforeNewWorker = new Promise<void>((resolve) => { activate = resolve })
  try {
    for (const version of ["old", "new"]) {
      await build({ root, logLevel: "error", build: { outDir: join(directory, version), emptyOutDir: true },
        plugins: [{ name: "release-marker",
          transformIndexHtml: (html) => html.replace("<head>", `<head><meta name="release-test" content="${version}">`)
            .replace("<body>", '<body><input aria-label="Unsaved test input" type="password">'),
          transform: (source, id) => id.endsWith("/screens/flows/FlowsScreen.tsx")
            ? source + `\ndocument.documentElement.dataset.flowsRelease = "${version}";` : undefined,
        }],
      })
    }
    const builds = await serveSiteBuilds({ old: join(directory, "old"), new: join(directory, "new"), beforeNewWorker })
    const origin = builds.url.origin
    try {
      await page.goto(`${origin}/app`)
      await expect(page.getByRole("link", { name: "Flows", exact: true })).toBeVisible()
      expect(hashedAssets.some((asset) => asset.path.endsWith(".js") && asset.cacheControl === "public, max-age=31536000, immutable")).toBe(true)
      expect(hashedAssets.some((asset) => asset.path.endsWith(".css") && asset.cacheControl === "public, max-age=31536000, immutable")).toBe(true)
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }))
      })
      const unsaved = page.getByLabel("Unsaved test input")
      await unsaved.fill("fixture")
      const before = documents
      builds.use("new")
      const lost = page.waitForResponse((r) => r.status() === 404 && /\/assets\/[^/]+\.js$/.test(new URL(r.url()).pathname))
      await page.getByRole("link", { name: "Flows", exact: true }).click()
      const lostResponse = await lost
      expectServerError(404, new URL(lostResponse.url()).pathname)
      expect(lostResponse.headers()["cache-control"]).toBe("no-store")
      expect(lostResponse.headers()["content-type"] ?? "").not.toContain("text/html")
      expect(await lostResponse.text()).toBe("")
      await expect(page.getByText("Couldn't show this page", { exact: true })).toBeVisible()
      expect(records).toEqual([])
      expect(documents).toBe(before)
      await expect(unsaved).toHaveValue("fixture")
      const controlling = page.evaluate(() => new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })))
      activate()
      await controlling
      await expect(unsaved).toHaveValue("fixture")
      await expect(page.locator('meta[name="release-test"]')).toHaveAttribute("content", "old")
      expect(records).toEqual([])
      await unsaved.fill("")
      await expect(page.locator("html")).toHaveAttribute("data-flows-release", "new", { timeout: 30_000 })
      await expect(page.locator('meta[name="release-test"]')).toHaveAttribute("content", "new")
      expect(documents).toBe(before + 1)
      expect(records.filter((line) => line.includes("stale_module"))).toHaveLength(1)

      // Verify retired CSS, app deep links, and unknown-route 404 recovery directly through the live Miniflare site Worker.
      const retiredCss = await page.request.get(`${origin}/assets/retired-12345678.css`, { headers: { accept: "text/css,*/*;q=0.1" } })
      expect(retiredCss.status()).toBe(404)
      expect(retiredCss.headers()["cache-control"]).toBe("no-store")
      expect(retiredCss.headers()["content-type"] ?? "").not.toContain("text/html")
      expect(await retiredCss.text()).toBe("")

      const deepLink = await page.request.get(`${origin}/owner/repo/blob/main/src/file.ts`, { headers: { accept: "text/html" } })
      expect(deepLink.status()).toBe(200)
      expect(deepLink.headers()["content-type"]).toContain("text/html")
      expect(deepLink.headers()["cache-control"] ?? "").not.toContain("immutable")

      expectServerError(404, "/_definitely-missing-page")
      const uncontrolled = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true })
      try {
        const missingPage = await uncontrolled.newPage()
        const missingDoc = await missingPage.goto(`${origin}/_definitely-missing-page`)
        expect(missingDoc?.status()).toBe(404)
        expect(missingDoc?.headers()["x-robots-tag"]).toBe("noindex")
        expect(missingDoc?.headers()["cache-control"] ?? "").not.toContain("immutable")
        await expect(missingPage.getByRole("link", { name: "Back to chat", exact: true })).toBeVisible({ timeout: 30_000 })
        await missingPage.goto("about:blank")
      } finally { await uncontrolled.close() }

      await page.goto("about:blank")
    } finally { activate(); await builds.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
