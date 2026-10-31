import { expect, test } from "./fixtures"
import { openAdd } from "./personal-model"
import { requires } from "./target"

requires("member")
for (const width of [1280, 390, 320]) {
  test(`model settings: an API key's fields align at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/app/settings")
    const section = page.getByRole("region", { name: "Your model", exact: true })
    await expect(section).toBeVisible({ timeout: 30_000 })
    const form = (await openAdd(section, page, "api_key")).getByRole("form", { name: "API key", exact: true })
    const base = await form.locator("#personal-model-base-url").boundingBox()
    const fast = await form.locator("#personal-model-fast").boundingBox()
    expect(base).not.toBeNull()
    expect(fast).not.toBeNull()
    expect(Math.abs(base!.x - fast!.x)).toBeLessThan(2)
    expect(Math.abs(base!.width - fast!.width)).toBeLessThan(2)
    for (const control of await form.locator('input:not([type="hidden"]), [role="combobox"]').all()) {
      const box = await control.boundingBox()
      expect(box!.width).toBeGreaterThan(100)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
    // W12 shared TIER_PURPOSE copy (personal-model.md); each tier has one description.
    await expect(form.getByText("Chat", { exact: true })).toBeVisible()
    await expect(form.getByText("Coding", { exact: true })).toBeVisible()
    await expect(form.getByText("Plans and reviews", { exact: true })).toBeVisible()
  })
}
