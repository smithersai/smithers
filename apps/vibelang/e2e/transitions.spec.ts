// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, type Page, test } from "./coverage"

// View transitions (VL-17): moving between the maximized splash and the chat runs a view transition typed by its
// direction; opening ⌘K runs none. The page records which typed transitions it renders; nothing is intercepted.
async function watch(page: Page) {
  await page.evaluate(() => {
    const seen: Array<string> = []
    Object.assign(window, { seenTransitions: seen })
    const frame = () => {
      for (const type of ["to-chat", "to-splash"]) {
        if (document.documentElement.matches(`:active-view-transition-type(${type})`) && seen.at(-1) !== type) seen.push(type)
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}

function seen(page: Page) {
  return page.evaluate(() => (window as unknown as { seenTransitions: Array<string> }).seenTransitions)
}

async function settled(page: Page) {
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
}

test("the splash and the chat change places with typed view transitions, and ⌘K opens without one", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "VibeLang" })).toBeVisible()
  await watch(page)
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
  await page.getByRole("textbox", { name: "Message" }).pressSequentially("How do I install it?")
  await page.keyboard.press("Enter")
  await expect(page.locator(".sui-chat-message[data-role='assistant']")).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  await settled(page)
  expect(await seen(page)).toEqual(["to-chat"])
  await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
  await expect(page.getByRole("heading", { name: "VibeLang" })).toBeVisible()
  await settled(page)
  expect(await seen(page)).toEqual(["to-chat", "to-splash"])
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog", { name: "Ask the agent" })).toBeVisible()
  await settled(page)
  expect(await seen(page)).toEqual(["to-chat", "to-splash"])
})
