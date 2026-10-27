import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage", "member")

test("missing branch: show absence instead of offering to refresh a mirror", async ({ page }) => {
  const workspace = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/branches")
  await page.goto("/smithersai/smithers/tree/no-such-branch")
  expect((await workspace).status()).toBe(204)
  await expect(page.getByText("Branch not found", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator(".branch-screen-view").getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0)
  await expect(page.locator('a[href="/smithersai/smithers"]').filter({ hasText: /^Code$/ })).toBeVisible()
})
