import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage", "member")

test("reader code: browse a public repository without a failed workspace request", async ({ page }) => {
  const workspace = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/branches")
  await page.goto("/smithersai/vibelang/tree/main")
  expect((await workspace).status()).toBe(204)
  await expect(page.locator(".repo-page")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("link", { name: "README.md", exact: true }).first()).toBeVisible()
  await expect(page.locator(".branch-screen-denied")).toContainText("No access")
})
