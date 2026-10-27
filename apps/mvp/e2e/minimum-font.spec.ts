import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

requires("chromium")

test.use({
  ...signedOut,
  viewport: { width: 640, height: 400 },
  contextOptions: { reducedMotion: "reduce", forcedColors: "active", contrast: "more" },
  launchOptions: { args: ["--blink-settings=minimumFontSize=20,minimumLogicalFontSize=20"] },
})

test("landing: the decorative wordmark fits with a native 20px minimum font", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Smithers", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Get started for free" })).toBeVisible()
  expect(await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })))
    .toEqual({ width: 640, scroll: 640 })
  const mark = page.locator(".sui-wordmark")
  const bounds = await mark.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(640)
  await expect(mark.locator("text, pre, span")).toHaveCount(0)
})
