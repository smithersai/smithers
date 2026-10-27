import { expect } from "@playwright/test"
import { test } from "./fixtures"

for (const width of [390, 1280]) test.describe(`${width}px navigation chrome`, () => {
  test.use({ viewport: { width, height: 844 } })
  test("chat navigation stays compact and uses themed links", async ({ page }) => {
    await page.goto("/app")
    const nav = page.getByRole("navigation", { name: "Pages" })
    await expect(nav).toBeVisible()
    for (const link of await nav.getByRole("link").all()) {
      await expect(link).not.toHaveCSS("color", "rgb(0, 0, 238)")
      await expect(link).toHaveCSS("text-decoration-line", "none")
    }
    if (width === 390) expect((await page.locator(".app-shell-header").boundingBox())!.height).toBeLessThanOrEqual(112)
  })

})
