import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("phone docs: short flags stay intact at narrow line boundaries", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/reference/cli/")
  for (const width of [320, 360, 375, 390, 414, 430]) {
    await page.setViewportSize({ width, height: 844 })
    const help = page.locator(".sl-markdown-content p code").filter({ hasText: /^--help$/ }).first()
    const lines = await help.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return [...new Set([...range.getClientRects()].map(rect => rect.y))].length
    })
    expect(lines, `--help at ${width}px`).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
