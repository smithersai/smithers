import { expect } from "@playwright/test"
import { test } from "./fixtures"

test("docs sidebar labels do not interrupt document heading navigation", async ({ page }) => {
  await page.goto("/smithersai/vibelang/docs")
  const sidebar = page.locator(".docs-page-nav")
  await expect(sidebar.getByRole("searchbox")).toBeVisible()
  await expect(sidebar.getByRole("heading")).toHaveCount(0)
  await expect(page.locator(".docs-page-index, .docs-page-shown").getByRole("heading").first()).toBeVisible()
})
