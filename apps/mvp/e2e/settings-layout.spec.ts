import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member")
for (const width of [1280, 390, 320]) {
  test(`model settings align credential columns and tiers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/app/settings")
    const form = page.getByRole("form", { name: "Your model", exact: true })
    await expect(form).toBeVisible()
    const base = await form.locator('#personal-model-openai-chat-base-url').boundingBox()
    const fast = await form.locator('#personal-model-fast').boundingBox()
    expect(base).not.toBeNull()
    expect(fast).not.toBeNull()
    expect(Math.abs(base!.x - fast!.x)).toBeLessThan(2)
    expect(Math.abs(base!.width - fast!.width)).toBeLessThan(2)
    for (const control of await form.locator('input, [role="combobox"]').all()) {
      const box = await control.boundingBox()
      expect(box!.width).toBeGreaterThan(100)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
    await expect(form.getByRole("textbox", { name: "OpenAI-compatible Base URL", exact: true })).toBeVisible()
    await expect(form.getByRole("textbox", { name: "Anthropic-compatible Base URL", exact: true })).toBeVisible()
    await expect(form.getByText("Chat", { exact: true })).toBeVisible()
    await expect(form.getByText("Code", { exact: true })).toBeVisible()
    await expect(form.getByText("Plans & reviews", { exact: true })).toBeVisible()
  })
}
