// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// A run start that answers after the person's role changed. `held-start` and `held-start-failed`
// (test/support/heldActions.vibe) hold the first start until the page's `recovery.release()`; the page's snapshot
// turns `faulted` true once the held start has answered.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

type Recovery = { recovery: { snapshot(): { faulted: boolean }; release(): unknown } }

/** Opens Actions on Tour, presses Run (held), switches role, then releases the held start and waits for its answer. */
async function startThenSwitch(page: Page, fault: string) {
  await page.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=${fault}`)
  await page.keyboard.press("ControlOrMeta+k")
  const input = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
  await input.fill("Hello")
  await input.press("Enter")
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  const pane = page.getByRole("region", { name: "Actions", exact: true })
  await pane.getByRole("button", { name: "Tour", exact: true }).click()
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  const role = page.getByRole("combobox", { name: "Visit as" })
  await role.selectOption("maintainer")
  await expect(role).toHaveValue("maintainer")
  await page.evaluate(() => (window as unknown as Recovery).recovery.release())
  await expect.poll(() => page.evaluate(() => (window as unknown as Recovery).recovery.snapshot().faulted)).toBe(true)
  // The held answer's message is dispatched within a task of `faulted`; two frames later the page has rendered it.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  return pane
}

test("a run started before the role changed does not join the new role's runs", async ({ page }) => {
  const pane = await startThenSwitch(page, "held-start")
  const cards = page.getByRole("button", { name: /Open Tour run/ })
  await expect(cards).toHaveCount(0)
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  await expect(cards).toHaveCount(1)
})

test("a start that fails after the role changed shows no error", async ({ page }) => {
  const pane = await startThenSwitch(page, "held-start-failed")
  await expect(pane.getByRole("alert")).toHaveCount(0)
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  await expect(page.getByRole("button", { name: /Open Tour run/ })).toHaveCount(1)
  await expect(pane.getByRole("alert")).toHaveCount(0)
})
