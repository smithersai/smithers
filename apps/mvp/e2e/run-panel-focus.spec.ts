import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member", "inspectRun")
test("run: the Steps panel shows keyboard focus", async ({ page }) => {
  const run = process.env.E2E_INSPECT_RUN
  await page.goto(`/app/runs/${encodeURIComponent(run!)}`)
  const tab = page.getByRole("tab", { name: /^Steps/ })
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.focus()
  await page.keyboard.press("Tab")
  const panel = page.getByRole("tabpanel", { name: /^Steps/ })
  await expect(panel).toBeFocused()
  expect(await panel.evaluate(element => {
    const style = getComputedStyle(element)
    return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none"
  })).toBe(true)
})
