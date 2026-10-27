import { expect, test } from "./fixtures"
import { requires } from "./target"

for (const [suffix, label] of [["issues", "Syncing issues…"], ["pulls", "Syncing pull requests…"]] as const) {
  test(`${suffix}: a cold list has rows or feedback from its first paint`, async ({ page }) => {
    requires("githubApp")
    await page.addInitScript(() => {
      const blank: string[] = []
      Object.assign(window, { listBlanks: blank })
      const inspect = () => {
        const list = document.querySelector('[data-slot="issues-view"]')
        if (list && !list.querySelector('.sui-issues-list, .sui-issues-counts') && !document.querySelector('[data-list-sync]')) blank.push(location.pathname)
        requestAnimationFrame(inspect)
      }
      requestAnimationFrame(inspect)
    })
    await page.goto(`/smithersai/smithers/${suffix}`)
    await expect(page.locator('[data-slot="issues-view"]')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.sui-issues-list').or(page.getByText(label, { exact: true }))).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { listBlanks: string[] }).listBlanks)).toEqual([])
  })
}
