// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test, type Page } from "@playwright/test"

const input = (page: Page) => page.getByRole("textbox", { name: "Message" })

async function open(page: Page) {
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog", { name: "Ask the agent" }).getByRole("textbox", { name: "Message" })).toBeFocused()
}
async function type(page: Page, value: string) {
  await expect(input(page)).toBeFocused()
  await input(page).pressSequentially(value)
  await expect(input(page)).toHaveValue(value)
}

test("6: Enter focuses the docked composer; Escape and a second shortcut restore its draft and focus", async ({ page }) => {
  await page.goto("/")
  await open(page)
  await type(page, "What is a service?")
  await input(page).press("Enter")
  await expect(page.locator("[data-docked] textarea")).toBeFocused()
  await expect(page.getByRole("dialog")).toBeHidden()
  await type(page, "follow up without refocus")
  await open(page)
  await expect(input(page)).toHaveValue("follow up without refocus")
  await input(page).press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(input(page)).toBeFocused()
  await open(page)
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(input(page)).toBeFocused()
  await expect(input(page)).toHaveValue("follow up without refocus")
})

test("6: Escape returns to the actual keyboard opener on the splash", async ({ page }) => {
  await page.goto("/")
  const ask = page.getByRole("button", { name: "Ask the agent" })
  // Traverse the rendered nav (including account controls) using only the keyboard.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab")
    if (await ask.evaluate(node => node === document.activeElement)) break
  }
  await expect(ask).toBeFocused()
  await ask.press("Enter")
  await expect(input(page)).toBeFocused()
  await type(page, "unsent draft")
  await input(page).press("Escape")
  await expect(ask).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(page.getByRole("button", { name: "Learn more" })).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  const source = page.getByRole("button", { name: "Sign in", exact: true })
  await expect(source).toBeFocused()
  await open(page)
  await input(page).press("Escape")
  await expect(source).toBeFocused()
})

test("8: the palette contains Tab and Shift+Tab and excludes the background accessibility tree", async ({ page }) => {
  await page.goto("/")
  await open(page)
  await page.keyboard.press("Shift+Tab")
  await expect(input(page)).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(input(page)).toBeFocused()
  await type(page, "a draft")
  const send = page.getByRole("button", { name: "Send" })
  await expect(send).toBeEnabled()
  await page.keyboard.press("Shift+Tab")
  await expect(send).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(input(page)).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(send).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(input(page)).toBeFocused()
  await expect(page.getByRole("link", { name: "Docs" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Home" })).toHaveCount(0)
  await expect(page.getByRole("dialog")).toHaveAttribute("aria-modal", "true")
})

