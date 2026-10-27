import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member")
test("signed-in home opens Smithers", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("link", { name: "Open Smithers", exact: true })).toBeVisible()
  await expect(page.getByText("Get started for free", { exact: true })).toHaveCount(0)
  await page.getByRole("link", { name: "Open Smithers", exact: true }).click()
  await expect(page).toHaveURL(/\/app$/)
})
