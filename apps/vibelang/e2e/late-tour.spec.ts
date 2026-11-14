// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// A tour start that answers after the person ended the tour. `held-tour` (test/support/FaultyFactory.vibe) holds the
// first tour start until the page's `recovery.release()`; `faulted` in the page's snapshot turns true as it ends.
import { expect, test } from "./coverage"

type Recovery = { recovery: { snapshot(): { faulted: boolean }; release(): unknown } }

test("a tour start that lands after Esc ends that tour and gives the page back", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=held-tour`)
  await page.getByRole("button", { name: "Learn more" }).click()
  const escape = page.getByRole("button", { name: "Esc", exact: true })
  await expect(escape).toBeVisible()
  await escape.click()
  await expect(escape).toBeHidden()
  await page.evaluate(() => (window as unknown as Recovery).recovery.release())
  await expect.poll(() => page.evaluate(() => (window as unknown as Recovery).recovery.snapshot().faulted)).toBe(true)
  // The held answer's message is dispatched within a task of `faulted`; two frames later the page has rendered it.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await expect(escape).toBeHidden()
  await expect(page.locator(".vl-theatre-bar")).toBeHidden()
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible()
})
