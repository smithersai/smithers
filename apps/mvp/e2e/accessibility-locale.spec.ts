import { expect } from "@playwright/test"
import { test } from "./fixtures"

for (const locale of ["ar", "ja", "de"]) test.describe(locale, () => {
  test.use({ locale, viewport: { width: 390, height: 844 } })
  test("document follows browser language and direction", async ({ page }) => {
    await page.goto("/app")
    await expect(page.locator("html")).toHaveAttribute("lang", locale)
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr")
  })
})
