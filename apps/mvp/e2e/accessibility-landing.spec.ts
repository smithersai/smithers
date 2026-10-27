import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { signedOut } from "./target"

test.use(signedOut)
for (const width of [320, 1280]) test.describe(`${width}px landing landmarks`, () => {
  test.use({ viewport: { width, height: 844 } })
  test("existing identity, start action and source link have landmarks", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("banner").getByRole("heading", { name: "Smithers" })).toBeVisible()
    await expect(page.getByRole("main").getByRole("link", { name: "Get started for free" })).toBeVisible()
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "GitHub" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})
