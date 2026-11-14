// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"

// The first Export of the mock's whole history (seed/vibelang.vibe, about 5,700 mythical commits) hashes, writes and
// reads back every commit in the page. It gives the page a turn between chunks (export.vibe `breathe`), so no task
// while it runs is 200 ms or longer, and input and paint go on. Chromium reports each task over 50 ms as a long task.

declare global {
  interface Window { longTasks: Array<{ start: number; duration: number }> }
}

test("the first export never blocks the page for 200 ms", async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    window.longTasks = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.longTasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: "longtask" })
  })
  await page.goto("/history?agent=mock")
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
  const from = await page.evaluate(() => performance.now())
  await page.getByRole("button", { name: "Export", exact: true }).click()
  await expect(page.getByTitle("Exported")).toHaveText(/^mythical \S{7}$/, { timeout: 60_000 })
  const longest = await page.evaluate((after) => Math.max(0, ...window.longTasks.filter((task) => task.start >= after).map((task) => task.duration)), from)
  expect(longest).toBeLessThan(200)
})
