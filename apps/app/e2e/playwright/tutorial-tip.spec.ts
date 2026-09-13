import { expect, test } from "@playwright/test"
import { GUIDE_STAGES } from "../../src/mainview/onboarding/lessons"

test.use({ contextOptions: { reducedMotion: "reduce" } })

for (const width of [1280, 390]) {
  test(`tutorial tip is a notification for 15 seconds at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.clock.install()
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Start tutorial" })).toBeVisible()
    await page.clock.pauseAt(new Date(Date.now() + 60_000))
    await page.getByRole("button", { name: "Start tutorial" }).click()
    const tip = page.locator('.guide-toasts .guide-tip[role="status"]')
    const lesson = GUIDE_STAGES[1]!
    expect(lesson.kind).toBe("do")
    await expect(tip.locator("p")).toHaveText(lesson.kind === "do" ? lesson.tip! : "")
    await expect(page.locator(".guide-transcript .guide-tip")).toHaveCount(0)
    await expect(page.locator(".guide-tip")).toHaveCount(1)
    await page.clock.runFor(14_999)
    await expect(tip).toBeVisible()
    const bounds = await tip.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: `/tmp/smithers-tutorial-tip-${width}.png` })
    await page.clock.runFor(1)
    await expect(tip).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Show issues" })).toBeVisible()
  })
}

test("tutorial tip can be dismissed with the keyboard", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Start tutorial" }).click()
  await page.getByRole("button", { name: "Dismiss Tip", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".guide-tip")).toHaveCount(0)
})
