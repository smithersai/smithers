import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { serveBuilds } from "./builds"
import { expect, step, test } from "./fixtures"
import { requires } from "./target"

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
        await page.waitForTimeout(5_000)
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
