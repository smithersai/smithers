// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// A details failure that arrives after the person has moved to another issue. The faulty Factory
// (test/support/FaultyFactory.vibe, `held-details`) runs live mode and holds the first issue's details read until the
// next details read has answered, then fails it; `faulted` in the page's snapshot turns true once it has.
import { expect, test } from "./coverage"

test("a comment load that fails after the person moved to another issue shows no error there", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=held-details`)
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
  await expect(page.getByRole("heading", { name: "#42", exact: true })).toBeVisible()
  await page.getByRole("link", { name: "‹ Issues", exact: true }).click()
  await page.getByRole("link", { name: "Effect-native modules", exact: true }).click()
  await expect(page.getByRole("heading", { name: "#38", exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { recovery: { snapshot(): { faulted: boolean } } }).recovery.snapshot().faulted)).toBe(true)
  // The failed read's message is dispatched within a task of `faulted`; two frames later the page has rendered it.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await expect(page.getByRole("heading", { name: "#38", exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})
