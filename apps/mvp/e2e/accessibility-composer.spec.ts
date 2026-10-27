import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires } from "./target"

test("chat entry precedes message actions in keyboard order", async ({ page }) => {
  requires("member")
  await page.goto("/app")
  const entry = page.locator(".app-shell-composer").locator("button, textarea").first()
  await expect(entry).toBeVisible()
  for (let tabs = 0; tabs < 25; tabs++) {
    await page.keyboard.press("Tab")
    if (await entry.evaluate(element => element === document.activeElement)) break
    expect(await page.locator(".app-shell-conversation").evaluate(element => element.contains(document.activeElement))).toBe(false)
  }
  await expect(entry).toBeFocused()
})
