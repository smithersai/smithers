import { expect, test } from "@playwright/test"

for (const path of ["/smithersai/smithers/", "/smithersai/smithers/?tutorial"]) {
  test(`arrow and group navigation keep the palette selection visible: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await page.keyboard.press("Meta+k")
    const input = page.getByTestId("composer-input")
    await input.fill("/")
    const palette = page.getByTestId("palette")
    await expect(palette.locator('[role="option"]').nth(10)).toBeAttached()
    for (const key of [...Array(12).fill("ArrowDown"), "ArrowUp", "Tab", "Shift+Tab"]) {
      await input.press(key)
      await expect(palette.locator('[aria-selected="true"]')).toBeInViewport({ ratio: 1 })
      await expect(input).toBeFocused()
    }
  })
}
