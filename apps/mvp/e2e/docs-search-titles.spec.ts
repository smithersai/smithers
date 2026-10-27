import { expect, test } from "./fixtures"

test.use({ storageState: { cookies: [], origins: [] } })
test("docs search shows each page title once and retains section matches", async ({ page }) => {
  await page.goto("/docs/")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  const results = page.locator("#starlight__search")
  await results.getByRole("textbox").fill("quickstart")
  await expect(results.getByRole("link", { name: "Quickstart", exact: true }).filter({ visible: true })).toHaveCount(1)
  await expect(results.getByRole("link", { name: "@smthrs/scorers", exact: true }).filter({ visible: true })).toHaveCount(1)
  await expect(results.locator('a[href$="#_top"]').filter({ visible: true })).toHaveCount(0)
  await expect(results.locator('a[href*="#next-steps"]').first()).toBeVisible()
})
