import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { signedOut } from "./target"

test.use({ ...signedOut, viewport: { width: 390, height: 844 } })
test("repository install command scrolls on one line", async ({ page }) => {
  await page.goto("/smithersai/vibelang")
  const command = page.locator(".sui-rh-install code")
  await expect(command).toBeVisible()
  await expect(command).toHaveCSS("white-space", "pre")
  await expect(command).toHaveCSS("overflow-x", "auto")
  await command.focus()
  await expect(command).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
