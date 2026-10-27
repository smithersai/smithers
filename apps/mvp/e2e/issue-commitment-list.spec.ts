import { expect, test } from "./fixtures"
import { requires } from "./target"

test("No commitment includes unlabeled issues", async ({ page }) => {
  requires("githubApp")
  await page.goto("/smithersai/smithers/issues?commitment=none")
  await expect(page.locator('[data-slot="issues-row"]').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("No issues", { exact: true })).toHaveCount(0)
})
