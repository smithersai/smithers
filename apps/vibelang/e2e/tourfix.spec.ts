// Playwright discovers browser tests only in .ts/.js files.
import { test, expect } from "./coverage"
import type { Page, Locator } from "./coverage"
async function inside(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!, viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
}
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes")) })
test("theatre fits every driven screen, with reachable 44px controls and reduced motion", async ({ page }, info) => {
  test.setTimeout(60000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  if (info.project.name === "phone") await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  for (let n = 1; n <= 9; n++) {
    await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", String(n))
    await inside(page, page.locator(".vl-theatre-bar"))
    await inside(page, page.locator(".vl-theatre-spotlight"))
    await inside(page, page.locator(".vl-esc"))
    for (const button of await page.locator(".vl-theatre-controls button").all()) {
      const box = (await button.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    await expect(page.locator(".vl-theatre-progress .current")).toHaveCSS("animation-name", "none")
    await page.getByRole("button", { name: "Skip", exact: true }).click()
  }
  await expect(page.locator(".vl-glow")).toHaveCount(0)
  await expect(page.locator("#vl-prompt")).toBeFocused()
  await expect(page.locator('[data-walkthrough="true"]')).toContainText("That's the factory")
})
test("reload retains paused issue #48 without a duplicate post; exit stays ended", async ({ page }) => {
  test.setTimeout(60000)
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  for (let n = 1; n <= 3; n++) {
    await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", String(n))
    await page.getByRole("button", { name: "Skip", exact: true }).click()
  }
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", "4")
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-paused", "true")
  await page.reload()
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", "4")
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-paused", "true")
  await expect(page.locator(".sui-item-conv")).toContainText("#48")
  await page.keyboard.press("Escape")
  await expect(page.locator(".vl-glow")).toHaveCount(0)
  await expect(page.locator('.sui-chat-message[data-role="user"]')).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole("button", { name: "Learn more", exact: true })).toBeVisible()
  await expect(page.locator(".vl-glow")).toHaveCount(0)
})

test("the detail spotlight wraps the actual issue card", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  for (let n = 1; n < 4; n++) {
    await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", String(n))
    await page.getByRole("button", { name: "Skip", exact: true }).click()
  }
  await expect(page.locator(".sui-item-conv")).toContainText("#48")
  await expect.poll(async () => {
    const card = await page.locator(".sui-item-conv").boundingBox(), spot = await page.locator(".vl-theatre-spotlight").boundingBox()
    return !!card && !!spot && Math.abs(card.x - spot.x) <= 3 && Math.abs(card.y - spot.y) <= 3
  }).toBe(true)
})

test("the composer and real slash menu sit above subtitles inside the spotlight", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  for (let n = 1; n < 8; n++) {
    await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", String(n))
    await page.getByRole("button", { name: "Skip", exact: true }).click()
  }
  await expect(page.getByRole("option").filter({ hasText: "/tour" })).toBeVisible()
  await expect.poll(async () => {
    const form = await page.locator('form[data-docked="true"]').boundingBox(), spot = await page.locator(".vl-theatre-spotlight").boundingBox(), bar = await page.locator(".vl-theatre-bar").boundingBox(), menu = await page.getByRole("listbox", { name: "Commands" }).boundingBox()
    return !!form && !!spot && !!bar && !!menu && form.y + form.height < bar.y && spot.y <= menu.y + 3 && spot.y + spot.height >= form.y + form.height - 3
  }).toBe(true)
  await page.getByRole("button", { name: "Skip", exact: true }).click()
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", "9")
  await page.keyboard.press("Escape")
  await page.locator("#vl-prompt").click({ trial: true })
})
