// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// A second walkthrough in one tab: Learn more starts it in the session's one tour conversation (src/web/main.vibe
// `learnMore`), after the first tour's start and end. The page follows that conversation from its first event, so the
// first tour's end arrives again; it must not end the tour that runs now, live or after a reload.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

const startTour = async (page: Page) => {
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  const bar = page.getByRole("region", { name: "Walkthrough" })
  await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  return bar
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vibelang:toured", "yes")
    localStorage.setItem("vibelang:tour-sound", "off")
  })
})

test("a second tour runs after the first one ended", async ({ page }) => {
  await page.goto("/?agent=mock")
  await startTour(page)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("region", { name: "Walkthrough" })).toHaveCount(0)
  await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
  const bar = await startTour(page)
  await page.getByRole("button", { name: "Skip", exact: true }).click()
  await expect(bar).toHaveAttribute("data-step", "2", { timeout: 15_000 })
  await expect(page.getByRole("status", { name: "Tour" })).toContainText("Agent controlling")
})

test("a second tour survives a reload", async ({ page }) => {
  await page.goto("/?agent=mock")
  await startTour(page)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("region", { name: "Walkthrough" })).toHaveCount(0)
  await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
  const bar = await startTour(page)
  await page.getByRole("button", { name: "Skip", exact: true }).click()
  await expect(bar).toHaveAttribute("data-step", "2", { timeout: 15_000 })
  await page.reload()
  await expect(page.getByRole("region", { name: "Walkthrough" })).toHaveAttribute("data-step", "2", { timeout: 15_000 })
  await expect(page.getByRole("status", { name: "Tour" })).toContainText("Agent controlling")
})
