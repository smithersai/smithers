import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member", "chromium")
test.use({ contextOptions: { reducedMotion: "reduce", forcedColors: "active", contrast: "more" },
  launchOptions: { args: ["--blink-settings=minimumFontSize=20,minimumLogicalFontSize=20"] } })

test("settings: protocol labels and arrows fit with a native 20px minimum font", async ({ page }) => {
  for (const width of [640, 390, 320]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto("/app/settings")
    await expect(page.locator(".personal-model-tier-row [data-slot=select-trigger]")).toHaveCount(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    const overflow = await page.locator(".personal-model-tier-row [data-slot=select-trigger]").evaluateAll((els) =>
      els.map((el) => el.scrollWidth > el.clientWidth))
    expect(overflow).toEqual([false, false, false])
  }
})
