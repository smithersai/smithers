import { expect, test } from "./fixtures"

test("flows: the short address opens the flows page", async ({ page }) => {
  await page.goto("/flows")
  await expect(page).toHaveURL(/\/app\/flows$/)
  await expect(page.getByRole("heading", { name: "Flows", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Back to chat" })).toBeVisible()
})
