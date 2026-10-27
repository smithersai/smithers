import { mirroredFile } from "./repository-prerequisites"
import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

requires("codeStorage", "member")

for (const visitor of [false, true]) test.describe(visitor ? "visitor" : "signed in", () => {
  if (visitor) test.use(signedOut)
  test("a file under tree redirects to its file view", async ({ page }) => {
    test.setTimeout(180_000)
    // W12 navigation.md bounds alias reads: only a confirmed file redirects; prepare the actual mirror first.
    await mirroredFile("smithersai/vibelang", "README.md")
    await page.goto("/smithersai/vibelang/tree/main/README.md")
    await expect(page).toHaveURL(/\/smithersai\/vibelang\/blob\/main\/README\.md$/, { timeout: 60_000 })
    await expect(page.getByRole("link", { name: "Raw", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(".repo-page")).toContainText("README.md")
    await page.reload()
    await expect(page.getByRole("link", { name: "Raw", exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
