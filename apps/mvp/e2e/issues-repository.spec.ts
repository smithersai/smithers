import { expect, test } from "./fixtures"
import { requires } from "./target"
import { as, REPO } from "./vibelang"

test("new issue on an unsynced repository: a signed-in reader gets its GitHub form", async ({ page }) => {
  requires("member")
  await as(page, "contributor")
  await page.goto(`${REPO}/issues/new`)
  await expect(page.locator('header[aria-label="Repository"]')).toContainText("smithersai / vibelang", { timeout: 30_000 })
  await expect(page.getByRole("link", { name: "Open an issue on GitHub" })).toHaveAttribute("href", "https://github.com/smithersai/vibelang/issues/new")
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
})
