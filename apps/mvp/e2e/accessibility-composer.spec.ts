import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires } from "./target"

// Safari's Tab skips links and buttons unless the person turned that on; Option-Tab reaches them.
test("chat entry precedes message actions in keyboard order", async ({ page, browserName }) => {
  requires("member")
  await page.goto("/app")
  const entry = page.locator(".app-shell-composer").locator("button, textarea").first()
  await expect(entry).toBeVisible({ timeout: 60_000 })
  for (let tabs = 0; tabs < 25; tabs++) {
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab")
    if (await entry.evaluate(element => element === document.activeElement)) break
    expect(await page.locator(".app-shell-conversation").evaluate(element => element.contains(document.activeElement))).toBe(false)
  }
  await expect(entry).toBeFocused()
})
