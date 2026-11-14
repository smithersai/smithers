// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// The person ends a tour while it is still speaking (src/core/flows.vibe `toured`'s race; flowDecision.vibe
// `tourStop`). `held-tour-step` (test/support/FaultyFactory.vibe) holds the journal write of the tour's first step
// under the room's lock, so the end the person asks for waits for that lock and lands before the tour can park.
import { expect, test } from "./coverage"

type Recovery = { recovery: { snapshot(): { faulted: boolean; holding: boolean }; release(): unknown } }

test("Esc while the tour is still on its first step ends it there and gives the page back", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=held-tour-step`)
  await page.getByRole("button", { name: "Learn more" }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as Recovery).recovery.snapshot().holding)).toBe(true)
  const escape = page.getByRole("button", { name: "Esc", exact: true })
  await expect(escape).toBeVisible()
  await escape.click()
  await page.evaluate(() => (window as unknown as Recovery).recovery.release())
  await expect.poll(() => page.evaluate(() => (window as unknown as Recovery).recovery.snapshot().faulted)).toBe(true)
  await expect(escape).toBeHidden()
  await expect(page.locator(".vl-theatre-bar")).toBeHidden()
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible()
})

// The same hold, with Pause instead of Esc: the pause waits for the room's lock and lands on the first step once it is
// written (src/core/MockFactory.vibe `control` reads the driven walkthrough, s11tour1).
test("Pause while the tour is still on its first step pauses it there", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=held-tour-step`)
  await page.getByRole("button", { name: "Learn more" }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as Recovery).recovery.snapshot().holding)).toBe(true)
  const pause = page.getByRole("button", { name: "Pause", exact: true })
  await expect(pause).toBeVisible()
  await pause.click()
  await page.evaluate(() => (window as unknown as Recovery).recovery.release())
  await expect.poll(() => page.evaluate(() => (window as unknown as Recovery).recovery.snapshot().faulted)).toBe(true)
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-paused", "true")
})
