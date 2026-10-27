import { expect, test } from "./fixtures"
import { requires } from "./target"

test("issue TODO links include their titles", async ({ page }) => {
  requires("githubApp")
  await page.goto("/smithersai/smithers/issues/4430")
  const links = page.locator('a[href^="/smithersai/smithers/stack/"]')
  await expect(links.first()).toBeVisible({ timeout: 60_000 })
  for (const link of await links.all()) await expect(link).toHaveText(/^T\d+ · .+/)
})
