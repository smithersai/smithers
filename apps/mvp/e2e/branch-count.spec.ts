import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage")

test("branch count: open the repository branch list", async ({ page }) => {
  await page.goto("/roninjin10/smithers-github-tests/tree/main")
  const branches = page.locator(".repo-counts").getByRole("link", { name: /Branches$/ })
  await expect(branches).toBeVisible({ timeout: 60_000 })
  await branches.click()
  await expect(page).toHaveURL(/\/roninjin10\/smithers-github-tests\/branches$/)
  await expect(page.getByRole("list", { name: "Branches", exact: true }).getByRole("link", { name: "main", exact: true })).toBeVisible({ timeout: 60_000 })
})
