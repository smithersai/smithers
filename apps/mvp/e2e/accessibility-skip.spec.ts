import { expect } from "@playwright/test"
import { test } from "./fixtures"

test("first Tab skips navigation to current content", async ({ page }) => {
  await page.goto("/app")
  await expect(page.locator("main#main-content")).toBeVisible({ timeout: 60_000 })
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("main")).toBeFocused()
})
