import { expect, test } from "./fixtures"
import { requires, scratchRepository } from "./target"

test("Create issue opens the numbered issue and survives a reload", async ({ page }) => {
  requires("syncedScratch")
  const repo = scratchRepository()
  const title = `Issue navigation ${crypto.randomUUID()}`
  await page.goto(`/${repo}/issues/new`)
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title)
  await page.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect(page).toHaveURL(/\/issues\/(?:new\?write=[0-9a-f-]+|\d+)$/, { timeout: 30_000 })
  await page.reload()
  await expect(page).toHaveURL(/\/issues\/\d+$/, { timeout: 60_000 })
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title)
})
