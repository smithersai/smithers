import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage")

test("branches URL: list branches and open main", async ({ page }) => {
  await page.goto("/roninjin10/smithers-github-tests/branches")
  await expect(page.getByRole("heading", { name: "Branches", exact: true })).toBeVisible({ timeout: 60_000 })
  const main = page.getByRole("list", { name: "Branches", exact: true }).getByRole("link", { name: "main", exact: true })
  await expect(main).toBeVisible({ timeout: 60_000 })
  await main.click()
  await expect(page).toHaveURL(/\/roninjin10\/smithers-github-tests\/tree\/main\/?$/)
  await expect(page.locator(".sui-ref-picker-trigger").first()).toBeVisible({ timeout: 60_000 })
})
