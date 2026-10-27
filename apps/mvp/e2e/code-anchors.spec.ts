import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage")

test("GitHub line anchors: scroll to a line and highlight a range", async ({ page }) => {
  const path = "/smithersai/smithers/blob/main/apps/mvp/PACKAGE.ts"
  await page.goto(`${path}#L72`)
  const selected = (n: number) => page.locator(`[data-line="${n}"][data-selected-line]`).first()
  await expect(selected(72)).toBeInViewport({ timeout: 60_000 })
  await page.goto(`${path}#L5-L12`)
  for (let n = 5; n <= 12; n++) await expect(selected(n)).toBeVisible({ timeout: 30_000 })
  await expect(selected(5)).toBeInViewport()
  await expect(selected(4)).toHaveCount(0)
  await expect(selected(13)).toHaveCount(0)
})
