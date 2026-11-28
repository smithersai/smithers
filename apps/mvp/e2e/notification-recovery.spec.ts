import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { serveSiteBuilds } from "./builds"
import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

test("a missing Workbench module leaves one working bell and toast stack", async ({ page }) => {
  requires("localServer")
  test.setTimeout(180_000)
  const directory = await mkdtemp(join(tmpdir(), "workbench-recovery-"))
  try {
    await build({ root: join(import.meta.dirname, ".."), logLevel: "error", build: { outDir: directory } })
    const assets = join(directory, "assets")
    const chunks = (await readdir(assets)).filter((name) => /^WorkbenchScreen-[^/]+\.js$/.test(name))
    expect(chunks).toHaveLength(1)
    await rm(join(assets, chunks[0]!))
    const site = await serveSiteBuilds({ old: directory, new: directory })
    try {
      expectServerError(404, `/assets/${chunks[0]}`)
      await page.goto(`${site.url.origin}/octocat/Spoon-Knife/workbench`)
      await expect(page.getByText("Couldn't show this page", { exact: true })).toBeVisible({ timeout: 30_000 })
      const bell = page.locator('[data-slot="notification-bell"]')
      await expect(bell).toHaveCount(1)
      await expect(page.locator(".root-notices")).toHaveCount(1)
      await bell.click()
      const panel = page.getByRole("dialog", { name: "Notifications" })
      await expect(panel).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(panel).toBeHidden()
      await expect(bell).toBeFocused()
      await page.goto("about:blank")
    } finally { await site.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
