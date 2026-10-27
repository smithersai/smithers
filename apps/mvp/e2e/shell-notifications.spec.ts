import { expect, test } from "./fixtures"

test.use({ storageState: { cookies: [], origins: [] } })
test("visitor notifications have an empty state", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Notifications", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Notifications" })).toContainText("No notifications")
})
