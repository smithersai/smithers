import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member")
test("a Member's empty secret list names who can add secrets", async ({ page }) => {
  await page.goto("/smithersai/smithers/settings/secrets")
  // An occupied list has no empty-state copy; this account must have no repository secrets for this check.
  await expect(page.getByText("No secrets · Admins add secrets", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toHaveCount(0)
})
