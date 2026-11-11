// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"

// The chat page's edges a person reaches: a tour whose events are lost, a resize during the tour, a modifier-click on
// a wiki link, and live sign-in, which hands the page to the server.

test("a tour whose events are lost follows them again, so Skip moves on", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?fault=tour-events")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  const bar = page.locator(".vl-theatre-bar")
  await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  await page.getByRole("button", { name: "Skip", exact: true }).click()
  await expect(bar).toHaveAttribute("data-step", "2", { timeout: 10_000 })
  await expect(page.locator(".sui-chat-message[data-role='user']")).toContainText("What makes VibeLang different")
})

test("a resize during the tour keeps its step", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  const bar = page.locator(".vl-theatre-bar")
  await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  await page.setViewportSize({ width: 700, height: 800 })
  await expect(bar).toHaveAttribute("data-step", "1")
  await expect(page.locator(".vl-glow")).toHaveCount(1)
})

test("a modifier-click on a wiki link is left to the browser", async ({ page }) => {
  await page.goto("/wiki/index?agent=mock")
  const link = page.locator(".vl-wiki-content a[href^='/wiki/']").first()
  await expect(link).toBeVisible({ timeout: 20_000 })
  // The window hears the click after the page's own listeners: whether they kept its default (a new tab).
  await page.evaluate(() => {
    const seen = window as unknown as { clickKept?: boolean }
    window.addEventListener("click", (event) => { seen.clickKept = !event.defaultPrevented; event.preventDefault() }, { once: true })
  })
  await link.click({ modifiers: ["ControlOrMeta"] })
  expect(await page.evaluate(() => (window as unknown as { clickKept?: boolean }).clickKept)).toBe(true)
  await expect(page).toHaveURL(/\/wiki\/index/)
  await expect(page.locator(".vl-wiki-content")).toBeVisible()
})

test("live sign-in goes to the server's sign-in", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?fault=live-header")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(/\/api\/auth\/sign-in$/)
})
