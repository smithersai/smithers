// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"
import type { Locator, Page } from "./coverage"

const input = (page: Page) => page.getByRole("textbox", { name: "Message" })
const answers = (page: Page) => page.locator(".sui-chat-message[data-role='assistant']")

async function open(page: Page) {
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog", { name: "Ask the agent" }).getByRole("textbox", { name: "Message" })).toBeFocused()
}
async function type(page: Page, value: string) {
  await expect(input(page)).toBeFocused()
  await input(page).pressSequentially(value)
  await expect(input(page)).toHaveValue(value)
}
async function newestAboveComposer(page: Page, target: Locator) {
  // Playwright's viewport matcher uses IntersectionObserver, unlike toBeVisible.
  await expect(target).toBeInViewport({ ratio: 1 })
  await expect.poll(async () => {
    const [end, composer] = await Promise.all([target.boundingBox(), page.locator("[data-docked]").boundingBox()])
    return end !== null && composer !== null && end.y + end.height <= composer.y
  }).toBe(true)
}

test("7: four follow-ups remain in the viewport; scrolling up pauses following until Latest", async ({ page }, info) => {
  await page.goto("/")
  await open(page)
  for (let i = 0; i < 5; i++) {
    // Focus explicitly here to keep the scroll regression independent of finding 6.
    await input(page).focus()
    await type(page, "What is a service?")
    await input(page).press("Enter")
    await expect(answers(page)).toHaveCount(i + 1)
    await expect(answers(page).last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
    await newestAboveComposer(page, answers(page).last().locator("p").last())
  }
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
  await page.screenshot({ path: info.outputPath("four-follow-ups.png") })
  await input(page).focus()
  await type(page, "What is a service?")
  await input(page).press("Enter")
  await expect(answers(page)).toHaveCount(6)
  await expect(answers(page).last()).toHaveAttribute("data-done", "false")
  await page.mouse.move(100, 250)
  await page.mouse.wheel(0, -10000)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  const latest = page.getByRole("button", { name: "Latest" })
  await expect(latest).toBeVisible()
  const before = await page.evaluate(() => window.scrollY)
  await expect(answers(page).last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
  await expect(answers(page).last()).not.toBeInViewport()
  await latest.click()
  await newestAboveComposer(page, answers(page).last().locator("p").last())
  await expect(latest).toBeHidden()
})

test("sending while scrolled up brings the new post and its answer into view (Fable review, finding 1)", async ({ page }) => {
  await page.goto("/")
  await open(page)
  for (let i = 0; i < 2; i++) {
    await input(page).focus()
    await type(page, "What is a service?")
    await input(page).press("Enter")
    await expect(answers(page)).toHaveCount(i + 1)
    await expect(answers(page).last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  }
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
  await page.mouse.move(100, 250)
  await page.mouse.wheel(0, -10000)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page.getByRole("button", { name: "Latest" })).toBeVisible()
  await input(page).focus()
  await type(page, "How do errors work?")
  await input(page).press("Enter")
  await expect(answers(page)).toHaveCount(3)
  await expect(answers(page).last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  await newestAboveComposer(page, answers(page).last().locator("p").last())
  await expect(page.getByRole("button", { name: "Latest" })).toBeHidden()
})
