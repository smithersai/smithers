// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"

// The first Export of the mock's whole history (seed/vibelang.vibe, about 5,700 mythical commits) hashes, writes and
// reads back every commit in the page. It gives the page a turn every 500 items (export.vibe `breathe`), so input and
// paint go on while it runs. A page timer that re-arms itself counts the turns: it runs only between tasks, so the count
// depends on how often the Export yields, not on how fast the machine is. A long-task budget in milliseconds did: under
// a full gate's load the same build's longest task was 92 to 327 ms. Measured (decision 0016, session 12): 88 to 183
// turns with the Export's turns, under 3 workers or alone; 20 to 24 with them removed.

declare global {
  interface Window { turns: number; ticking: boolean }
}

test("the first export gives the page a turn throughout", async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto("/history?agent=mock")
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => {
    window.turns = 0
    window.ticking = true
    const tick = () => { if (!window.ticking) return; window.turns += 1; setTimeout(tick, 0) }
    setTimeout(tick, 0)
  })
  await page.getByRole("button", { name: "Export", exact: true }).click()
  await expect(page.getByTitle("Exported")).toHaveText(/^mythical \S{7}$/, { timeout: 60_000 })
  const turns = await page.evaluate(() => { window.ticking = false; return window.turns })
  expect(turns).toBeGreaterThanOrEqual(50)
})
