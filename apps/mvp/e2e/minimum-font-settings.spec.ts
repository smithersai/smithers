import { expect, test } from "./fixtures"
import { openAdd } from "./personal-model"
import { requires } from "./target"

requires("member", "chromium")
test.use({ contextOptions: { reducedMotion: "reduce", forcedColors: "active", contrast: "more" },
  launchOptions: { args: ["--blink-settings=minimumFontSize=20,minimumLogicalFontSize=20"] } })

test("settings: the protocol select fits with a native 20px minimum font", async ({ page }) => {
  for (const width of [640, 390, 320]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto("/app/settings")
    const dialog = await openAdd(page.getByRole("region", { name: "Your model" }), page, "api_key")
    const select = dialog.locator("[data-slot=select-trigger]")
    await expect(select).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    expect(await select.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
  }
})
