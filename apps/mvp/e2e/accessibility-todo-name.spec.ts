import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires, syncedRepository } from "./target"

test("Make TODO keeps its shortcut out of its accessible name", async ({ page }) => {
  requires("member", "githubApp", "syncedRepository")
  const repository = syncedRepository()
  await page.goto(`/${repository}/issues`)
  const list = page.locator('[data-slot="issues-view"]')
  await expect(list).toBeVisible({ timeout: 60_000 })
  await expect(list).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 })
  let href: string | undefined
  await expect.poll(async () => {
    href = await page.locator("a[href]").evaluateAll((links, prefix) => links.map(link => link.getAttribute("href")!).find(href => href.startsWith(prefix) && /^\d+$/.test(href.slice(prefix.length))), `/${repository}/issues/`)
    return href
  }, { timeout: 30_000 }).toBeTruthy()
  await page.goto(href!)
  await expect(page.getByRole("button", { name: "Make TODO", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Make TODO", exact: true })).toHaveAttribute("aria-keyshortcuts", "t")
})
