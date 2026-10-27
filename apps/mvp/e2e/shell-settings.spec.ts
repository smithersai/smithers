import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member")
test("a Member's repository settings have an empty state", async ({ page }) => {
  await page.goto("/smithersai/smithers/settings")
  await expect(page.getByText("No settings available", { exact: true })).toBeVisible()
})
