import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires, syncedRepository } from "./target"

test("plural pull item URL redirects to the canonical page", async ({ page }) => {
  requires("githubApp", "syncedRepository")
  const repo = syncedRepository()
  await page.goto(`/${repo}/pulls`)
  const list = page.locator('[data-slot="issues-view"]')
  await expect(list).toBeVisible({ timeout: 60_000 })
  await expect(list).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 })
  let href: string | undefined
  await expect.poll(async () => {
    href = await page.locator("a[href]").evaluateAll((links, prefix) => links.map(link => link.getAttribute("href")!).find(href => href.startsWith(prefix) && /^\d+$/.test(href.slice(prefix.length))), `/${repo}/pull/`)
    return href
  }, { timeout: 30_000 }).toBeTruthy()
  await page.goto(href!.replace("/pull/", "/pulls/"))
  await expect(page).toHaveURL(new RegExp(href! + "$"))
  await expect(page.getByRole("main")).toBeVisible()
})
