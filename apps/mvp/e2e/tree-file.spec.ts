import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

requires("codeStorage")

for (const visitor of [false, true]) test.describe(visitor ? "visitor" : "signed in", () => {
  if (visitor) test.use(signedOut)
  test("a file under tree redirects to its file view", async ({ page }) => {
    await page.goto("/smithersai/vibelang/tree/main/CONTRIBUTING.md")
    await expect(page).toHaveURL(/\/smithersai\/vibelang\/blob\/main\/CONTRIBUTING\.md$/, { timeout: 60_000 })
    await expect(page.getByRole("link", { name: "Raw", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(".repo-page")).toContainText("CONTRIBUTING.md")
    await page.reload()
    await expect(page.getByRole("link", { name: "Raw", exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
