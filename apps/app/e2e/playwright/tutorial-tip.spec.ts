import { expect, test } from "@playwright/test"
import { GUIDE_STAGES } from "../../src/mainview/onboarding/lessons"

test.use({ contextOptions: { reducedMotion: "reduce" } })

for (const width of [1280, 390]) {
  test(`tutorial help points at Show issues without covering it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.clock.install()
    await page.goto("/")
    await page.getByRole("button", { name: "Start tutorial" }).click()
    const help = page.getByRole("note", { name: "Help" })
    const target = page.getByRole("button", { name: "Show issues", exact: true })
    const lesson = GUIDE_STAGES[1]!
    await expect(help.locator(".help-bubble-content")).toHaveText(lesson.kind === "do" ? lesson.help!.content : "")
    await expect(page.locator(".guide-toasts .guide-tip")).toHaveCount(0)
    await expect(target).toHaveAttribute("aria-describedby", "guide-instruction-1 guide-help-1")
    await page.clock.runFor(20_000)
    await expect(help).toBeVisible()
    const bounds = await help.boundingBox()
    const button = await target.boundingBox()
    expect(bounds).not.toBeNull()
    expect(button).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(bounds!.y + bounds!.height).toBeLessThan(button!.y)
    expect(Math.abs(bounds!.x + bounds!.width / 2 - button!.x - button!.width / 2)).toBeLessThan(2)
    expect(button!.y + button!.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: `/tmp/smithers-tutorial-help-${width}.png` })
    await page.keyboard.press("i")
    await expect(help).toHaveCount(0)
    await expect(page.locator('.guide-transcript [data-testid="card-practice-issues"]')).toBeVisible()
  })
}

test("dismissal returns focus to Show issues and preserves its keyboard action", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Start tutorial" }).click()
  await page.getByRole("button", { name: "Dismiss help", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("note", { name: "Help" })).toHaveCount(0)
  const target = page.getByRole("button", { name: "Show issues", exact: true })
  await expect(target).toBeFocused()
  await expect(target).toHaveAttribute("aria-describedby", "guide-instruction-1")
  await page.keyboard.press("i")
  await expect(page.locator('.guide-transcript [data-testid="card-practice-issues"]')).toBeVisible()
})
