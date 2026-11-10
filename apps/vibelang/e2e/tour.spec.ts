// Playwright discovers browser tests only in .ts/.js files.
import { test, expect } from "./coverage"
test("Learn more remains primary with Ask the agent and Contribute secondary", async ({ page }) => {
  await page.goto("/?agent=mock")
  await expect(page.getByRole("button", { name: "Learn more", exact: true })).toHaveClass("vl-primary")
  await expect(page.getByRole("button", { name: "Ask the agent", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Contribute", exact: true })).toBeVisible()
})
test("first visit starts the walkthrough once; Escape marks it seen", async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("first-visit-test")) { localStorage.removeItem("vibelang:toured"); sessionStorage.setItem("first-visit-test", "yes") } })
  await page.goto("/?agent=mock")
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", "1", { timeout: 15000 })
  await page.keyboard.press("Escape")
  await expect(page.locator(".vl-glow")).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem("vibelang:toured"))).toBe("yes")
  await page.reload()
  await expect(page.getByRole("button", { name: "Learn more", exact: true })).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.locator(".vl-glow")).toHaveCount(0)
})
