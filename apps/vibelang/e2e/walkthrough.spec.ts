// Playwright discovers browser tests only in .ts/.js files.
import { test, expect } from "./coverage"
import type { Page } from "./coverage"
const bar = (page: Page) => page.getByRole("region", { name: "Walkthrough" })
async function step(page: Page, n: number) { await expect(bar(page)).toHaveAttribute("data-step", String(n), { timeout: 15000 }) }
async function skip(page: Page, n: number) { await page.getByRole("button", { name: "Skip", exact: true }).click(); await step(page, n) }
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vibelang:toured", "yes")
    localStorage.setItem("vibelang:tour-sound", "off")
    const calls = { speak: 0, cancel: 0 }
    Object.assign(window, { tourAudio: calls })
    // Observe calls while retaining the real browser speech implementation.
    const speak = speechSynthesis.speak.bind(speechSynthesis)
    const cancel = speechSynthesis.cancel.bind(speechSynthesis)
    speechSynthesis.speak = utterance => { calls.speak++; speak(utterance) }
    speechSynthesis.cancel = () => { calls.cancel++; cancel() }
  })
})
test("muted agent drives every real app surface, with pause, back, seek and exit", async ({ page }) => {
  test.setTimeout(90000)
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  await step(page, 1)
  await page.keyboard.press("Space")
  await expect(bar(page)).toHaveAttribute("data-paused", "true")
  await page.waitForTimeout(5100) // Proves a paused reading hold does not advance across five seconds.
  await step(page, 1)
  await page.keyboard.press("Space")
  await expect(bar(page)).toHaveAttribute("data-paused", "false")
  await skip(page, 2)
  await expect(page.locator('.sui-chat-message[data-role="user"]')).toContainText("What makes VibeLang different")
  await expect(page.locator('.sui-chat-message[data-role="assistant"][data-walkthrough]').count()).resolves.toBeGreaterThan(0)
  await expect(page.locator('.sui-chat-message[data-role="assistant"]:not([data-walkthrough])').last()).toHaveAttribute("data-done", "true")
  await skip(page, 3)
  await expect(page.getByRole("region", { name: "Issues pane" })).toBeVisible()
  await skip(page, 4)
  await expect(page.locator(".sui-item-conv")).toContainText("#48")
  await page.keyboard.press("ArrowLeft")
  await step(page, 3)
  await expect(page.getByRole("radiogroup", { name: "Kind" })).toBeVisible()
  await page.keyboard.press("ArrowRight")
  await step(page, 4)
  await skip(page, 5)
  await expect(page.locator(".sui-item-conv")).toContainText("#45")
  await skip(page, 6)
  await expect(page.getByRole("region", { name: "Wiki", exact: true })).toBeVisible()
  await expect(page.locator("#vl-wiki .vl-wiki-content")).toContainText("factory wiki")
  await skip(page, 7)
  await expect(page.getByRole("link", { name: "History", exact: true })).toBeVisible()
  await skip(page, 8)
  await expect(page.getByRole("option").filter({ hasText: "/tour" })).toBeVisible()
  await skip(page, 9)
  await expect(page.getByRole("region", { name: "Sandboxes", exact: true })).toBeVisible()
  await expect(page.getByRole("table", { name: "Minutes by role" })).toContainText("Contributor")
  expect(await page.evaluate(() => (window as unknown as { tourAudio: { speak: number } }).tourAudio.speak)).toBe(0)
  await page.keyboard.press("Escape")
  await expect(page.locator(".vl-glow")).toHaveCount(0)
  await expect(page.getByRole("status", { name: "Tour", exact: true })).toHaveText("Tour ended. You have control.")
  await expect(page.locator("#vl-prompt")).toBeFocused()
})
test("sound toggle cancels immediately; Exit returns keyboard control", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  await step(page, 1)
  await page.getByRole("button", { name: "Sound on", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { tourAudio: { speak: number } }).tourAudio.speak)).toBe(1)
  const beforeSeek = await page.evaluate(() => (window as unknown as { tourAudio: { cancel: number } }).tourAudio.cancel)
  await skip(page, 2)
  await expect.poll(() => page.evaluate(() => (window as unknown as { tourAudio: { speak: number } }).tourAudio.speak)).toBe(2)
  expect(await page.evaluate(() => (window as unknown as { tourAudio: { cancel: number } }).tourAudio.cancel)).toBeGreaterThan(beforeSeek)
  await page.keyboard.press("Space")
  await expect(bar(page)).toHaveAttribute("data-paused", "true")
  await page.keyboard.press("Space")
  await expect(bar(page)).toHaveAttribute("data-paused", "false")
  expect(await page.evaluate(() => (window as unknown as { tourAudio: { speak: number } }).tourAudio.speak)).toBe(2)
  await page.getByRole("button", { name: "Back", exact: true }).click()
  await step(page, 1)
  await expect.poll(() => page.evaluate(() => (window as unknown as { tourAudio: { speak: number } }).tourAudio.speak)).toBe(3)
  const beforeOff = await page.evaluate(() => (window as unknown as { tourAudio: { cancel: number } }).tourAudio.cancel)
  await page.getByRole("button", { name: "Sound off", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { tourAudio: { cancel: number } }).tourAudio.cancel)).toBeGreaterThan(beforeOff)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("vibelang:tour-sound"))).toBe("off")
  await page.getByRole("button", { name: "Exit", exact: true }).click()
  await expect(page.locator(".vl-glow")).toHaveCount(0)
  await expect(page.locator("#vl-prompt")).toBeFocused()
})

test("the full sound-off walkthrough advances itself and finishes in its reading budget", async ({ page }) => {
  test.setTimeout(190000)
  await page.goto("/?agent=mock")
  const began = Date.now()
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  await expect(page.locator('[data-walkthrough="true"][data-done="true"]')).toContainText("That's the factory", { timeout: 175000 })
  expect(Date.now() - began).toBeGreaterThanOrEqual(133000)
  await expect(page.locator(".vl-theatre-bar")).toHaveCount(0)
  await expect(page.locator("#vl-prompt")).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { tourAudio: { speak: number } }).tourAudio.speak)).toBe(0)
})

test("slash tour shares Learn more and keyboard focus stays in the theatre controls", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("/tour")
  await expect(page.getByRole("option").filter({ hasText: "/tour" })).toBeVisible()
  await page.keyboard.press("Enter")
  await step(page, 1)
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeFocused()
  for (const name of ["Skip", "Sound on", "Exit", "Pause"]) {
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name, exact: true })).toBeFocused()
  }
  await page.keyboard.press("Escape")
  await expect(page.locator("#vl-prompt")).toBeFocused()
})

test("Esc never covers a top-bar control while the agent drives", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  const esc = page.getByRole("button", { name: "Esc", exact: true })
  for (const n of [1, 2, 3]) {
    await step(page, n)
    await expect(esc).toBeVisible()
    const pill = (await esc.boundingBox())!
    for (const control of await page.locator(".vl-top a, .vl-top button, .vl-top select").all()) {
      if (!(await control.isVisible())) continue
      const box = (await control.boundingBox())!
      const overlaps = pill.x < box.x + box.width && box.x < pill.x + pill.width && pill.y < box.y + box.height && box.y < pill.y + pill.height
      expect(overlaps, `Esc covers ${await control.textContent()}`).toBe(false)
    }
    if (n < 3) await skip(page, n + 1)
  }
})
