// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// A command list that arrives after the person's role changed. `held-actions` (test/support/heldActions.vibe) holds
// the first list answered for a maintainer until the page's `recovery.release()`; the page's snapshot reports the
// actions it holds and turns `faulted` true once the held list has answered.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

type Recovery = { recovery: { snapshot(): { faulted: boolean; actionEntries: number }; release(): unknown } }

function snapshot(page: Page) {
  return page.evaluate(() => (window as unknown as Recovery).recovery.snapshot())
}

test("commands listed for a maintainer that arrive after the switch to viewer are not offered", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=held-actions`)
  const role = page.getByRole("combobox", { name: "Visit as" })
  await role.selectOption("maintainer")
  await expect(role).toHaveValue("maintainer")
  await role.selectOption("viewer")
  await expect(role).toHaveValue("viewer")
  // The maintainer's list is held, so the first list the page holds is the viewer's.
  await expect.poll(async () => (await snapshot(page)).actionEntries).toBeGreaterThan(0)
  await page.evaluate(() => (window as unknown as Recovery).recovery.release())
  await expect.poll(async () => (await snapshot(page)).faulted).toBe(true)
  // The held list's message is dispatched within a task of `faulted`; two frames later the page has rendered it.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true }).fill("/")
  await expect(page.getByRole("option", { name: "/tour Explore VibeLang", exact: true })).toBeVisible()
  await expect(page.getByRole("option", { name: "/post Ask the agent", exact: true })).toHaveCount(0)
})
