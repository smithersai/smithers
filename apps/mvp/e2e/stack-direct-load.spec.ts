import { expect, test } from "./fixtures"
import { requires } from "./target"

test("a direct TODO load never claims missing before sync", async ({ page }) => {
  requires("githubApp")
  await page.addInitScript(() => {
    const missing: string[] = []
    Object.assign(window, { earlyMissing: missing })
    new MutationObserver(() => {
      if (document.querySelector('main[aria-label="TODO"]')?.textContent?.includes("Not found")) missing.push("Not found")
    }).observe(document, { childList: true, subtree: true })
  })
  await page.goto("/smithersai/smithers/stack/4")
  await expect(page.getByText("Name the loop's current issue in dogfood-loop.md T4", { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(await page.evaluate(() => (window as unknown as { earlyMissing: string[] }).earlyMissing)).toEqual([])
})
