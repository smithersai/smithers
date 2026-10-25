import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { serveBuilds } from "./builds"
import { expect, step, test } from "./fixtures"
import { requires } from "./target"

test.use({ serviceWorkers: "allow" })

test("release: an open tab discovers and activates a second production build on navigation", async ({ page }) => {
  requires("localServer")
  const checks: string[] = []
  page.on("console", (message) => {
    if (message.text().startsWith("pwa.update.check")) checks.push(message.text())
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
      await step("Navigate in the app and receive the new release automatically", async () => {
        // A real router link: no manual registration.update(), reload or document navigation.
        await page.getByRole("link", { name: "Flows", exact: true }).click()
        await expect(page.locator('meta[name="release-test"]')).toHaveAttribute("content", "new", { timeout: 30_000 })
        expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
        expect(checks.some((record) => record.includes("navigation"))).toBe(true)
      })
    } finally { await builds.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
