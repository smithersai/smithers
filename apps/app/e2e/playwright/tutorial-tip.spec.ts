import { expect, test } from "@playwright/test"
import { GUIDE_STAGES } from "../../src/mainview/onboarding/lessons"

test.use({ contextOptions: { reducedMotion: "reduce" } })

for (const width of [1280, 390]) {
  test(`tutorial help points at Show issues without covering it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.clock.install()
    await page.goto("/")
    const help = page.getByRole("note", { name: "Help" })
    const target = page.getByRole("button", { name: "Show issues", exact: true })
    const lesson = GUIDE_STAGES[1]!
    await expect(page.getByRole("button", { name: "Review changes", exact: true })).toBeVisible()
    await expect(help.locator(".guidance-text-visual")).toHaveText(lesson.kind === "do" ? lesson.help!.introduction![0]!.content : "")
    await expect(page.locator(".guide-toasts .guide-tip")).toHaveCount(0)
    await expect(target).toHaveAttribute("aria-describedby", "guide-instruction-1 guide-help-1")
    await expect(page.locator("[data-help-pulse]")).toHaveCount(0)
    await expect(help.locator(".guidance-text-visual > span").last()).toHaveCSS("opacity", "1")
    const initialButton = await target.boundingBox()
    await page.clock.runFor(3800)
    await expect(help.locator(".guidance-text-visual")).toHaveText("Press C anytime to open Chat and commands.")
    const chat = page.getByRole("button", { name: "Chat", exact: true })
    await expect(chat).toHaveAttribute("aria-describedby", "guide-chat-help-1")
    const chatBounds = await chat.boundingBox()
    const chatHelpBounds = await help.boundingBox()
    expect(chatHelpBounds!.x).toBeGreaterThanOrEqual(0)
    expect(chatHelpBounds!.x + chatHelpBounds!.width).toBeLessThanOrEqual(width)
    expect(chatHelpBounds!.y + chatHelpBounds!.height).toBeLessThan(chatBounds!.y)
    const footer = await page.locator(".guide-footer").boundingBox()
    expect(chatHelpBounds!.y + chatHelpBounds!.height).toBeLessThan(footer!.y)
    const steadyButton = await target.boundingBox()
    expect(steadyButton!.x).toBeCloseTo(initialButton!.x, 0)
    expect(steadyButton!.y).toBeCloseTo(initialButton!.y, 0)
    await page.screenshot({ path: `/tmp/smithers-chat-guidance-${width}.png` })
    await page.clock.runFor(3800)
    await expect(help.locator(".guidance-text-visual")).toHaveText(lesson.kind === "do" ? lesson.help!.content : "")
    await expect(help).toBeVisible()
    await expect(page.locator("[data-help-pulse]")).toHaveCount(1)
    await expect(help).toHaveCSS("border-left-width", "4px")
    const bounds = await help.boundingBox()
    const button = await target.boundingBox()
    expect(bounds).not.toBeNull()
    expect(button).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(bounds!.y + bounds!.height).toBeLessThan(button!.y)
    // On narrow screens the bubble clamps to the viewport; its pointer still targets the button.
    const tipX = await help.evaluate(node => parseFloat((node as HTMLElement).style.getPropertyValue("--help-tip-x")))
    expect(Math.abs(bounds!.x + tipX - button!.x - button!.width / 2)).toBeLessThan(2)
    expect(button!.y + button!.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: `/tmp/smithers-tutorial-help-${width}.png` })
    await page.keyboard.press("i")
    await expect(help).toHaveCount(0)
    await expect(page.locator('.guide-transcript [data-testid="card-practice-issues"]')).toBeVisible()
  })
}

test("dismissal returns focus to Show issues and preserves its keyboard action", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Dismiss help", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("note", { name: "Help" })).toHaveCount(0)
  const target = page.getByRole("button", { name: "Show issues", exact: true })
  await expect(target).toBeFocused()
  await expect(target).toHaveAttribute("aria-describedby", "guide-instruction-1")
  await page.keyboard.press("i")
  await expect(page.locator('.guide-transcript [data-testid="card-practice-issues"]')).toBeVisible()
})

test("another suggestion opens practice changes without completing the issues lesson", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Review changes", exact: true })).toBeVisible()
  await page.keyboard.press("r")
  await expect(page.locator('.guide-transcript [data-kind="pr-list"]')).toBeVisible()
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await page.keyboard.press("i")
  await expect(page.getByRole("button", { name: "Read issue #3", exact: true })).toBeVisible()
})

test("only the final instruction pulses, and holding its key yields to pressed feedback", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.clock.install()
  await page.goto("/")
  const target = page.getByRole("button", { name: "Show issues", exact: true })
  await expect(target).toBeVisible()
  await expect(page.locator("[data-help-pulse]")).toHaveCount(0)
  await page.clock.runFor(5800)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-describedby", "guide-chat-help-1")
  await expect(page.locator("[data-help-pulse]")).toHaveCount(0)
  await page.clock.runFor(5500)
  await expect(target).toHaveCSS("animation-name", "help-target-glow")
  await expect(target.locator("kbd")).toHaveCSS("animation-name", "help-target-glow")
  await expect(target).toHaveCSS("animation-iteration-count", "infinite")
  // Text content also includes invisible letters: verify the last character
  // actually finishes revealing after delays greater than one second.
  const finalCharacter = page.locator(".guidance-text-visual > span").last()
  await expect(finalCharacter).toHaveCSS("opacity", "1")
  await page.keyboard.down("i")
  await expect(target).toHaveCSS("animation-name", "none")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await page.keyboard.up("i")
  await expect(page.getByRole("button", { name: "Read issue #3", exact: true })).toBeVisible()
})


test("typewriter paints every character of both instructions with motion enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/")
  const visual = page.locator('.help-bubble .guidance-text-visual')
  const painted = () => visual.evaluate(node => {
    const letters = [...node.children]
    return letters.length ? letters.filter(letter => getComputedStyle(letter).opacity === '1').map(letter => letter.textContent).join('') : node.textContent
  })
  await expect.poll(painted, { timeout: 15_000 }).toBe("Press C anytime to open Chat and commands.")
  await expect.poll(painted, { timeout: 15_000 }).toBe("Start with the practice repository’s issues. Click Show issues or press i.")
})
