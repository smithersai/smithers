import { expect, test } from "@playwright/test"
import { GUIDE_STAGES } from "../../src/mainview/onboarding/lessons"

test.use({ contextOptions: { reducedMotion: "reduce" } })

test.describe("landscape touch guidance", () => {
  test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 3, viewport: { width: 844, height: 390 } })

  test("Chat help stays inside the viewport and clears every action pill throughout its dwell", async ({ page }) => {
    test.setTimeout(120_000)
    // Practice guidance has no backend dependency; this also runs on Astro preview.
    await page.route("**/api/bootstrap", route => route.fulfill({ json: {
      apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: [], authFlow: "none", sandbox: null,
    } }))
    // Boot/network time must not consume an instruction's measured dwell.
    await page.clock.install({ time: 0 })
    await page.clock.pauseAt(0)
    await page.goto("/smithersai/smithers/?tutorial")
    await expect.poll(async () => {
      await page.clock.runFor(50)
      return page.locator(".guide-shell").count()
    }).toBe(1)
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
    const help = page.getByRole("note", { name: "Help" })
    await page.clock.runFor(4_000)
    await help.getByRole("button", { name: "Next" }).tap()
    for (let sample = 0; sample < 4; sample++) {
      await expect(help.locator(".guidance-text-visual")).toHaveText("Tap Chat anytime to open Chat and commands.")
      const bubble = (await help.boundingBox())!
      expect(bubble.x).toBeGreaterThanOrEqual(0)
      expect(bubble.y).toBeGreaterThanOrEqual(0)
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(844)
      expect(bubble.y + bubble.height).toBeLessThanOrEqual(390)
      const actions = page.locator(".guide-actions button.guide-primary")
      await expect(actions).toHaveCount(2)
      for (const action of await actions.all()) {
        const pill = (await action.boundingBox())!
        expect(bubble.x >= pill.x + pill.width || bubble.x + bubble.width <= pill.x || bubble.y >= pill.y + pill.height || bubble.y + bubble.height <= pill.y).toBe(true)
        expect(await action.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        })).toBe(true)
      }
      if (sample < 3) await page.clock.runFor(700)
    }
    await page.screenshot({ path: test.info().outputPath("landscape-chat-guidance.png") })
    const review = (await page.getByRole("button", { name: "Review changes", exact: true }).boundingBox())!
    await page.touchscreen.tap(review.x + review.width / 2, review.y + review.height / 2)
    await expect(page.locator('.guide-transcript [data-kind="pr-list"]')).toBeVisible()
  })
})

for (const width of [1280, 390]) {
  test(`tutorial help points at Show issues without covering it at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 844 })
    await page.clock.install()
    await page.goto("/")
    const help = page.getByRole("note", { name: "Help" })
    const target = page.getByRole("button", { name: "Show issues", exact: true })
    const lesson = GUIDE_STAGES[1]!
    await expect(page.getByRole("button", { name: "Review changes", exact: true })).toBeVisible()
    await expect(help.locator(".guidance-text-visual")).toHaveText(lesson.kind === "do" ? lesson.help!.introduction![0]!.content : "")
    await expect(page.locator(".toast-stack .guide-tip")).toHaveCount(0)
    await expect(target).toHaveAttribute("aria-describedby", "guide-instruction-1 guide-help-1")
    await expect(page.locator("[data-help-pulse]")).toHaveCount(0)
    await expect(help.locator(".guidance-text-visual > span").last()).toHaveCSS("opacity", "1")
    const initialButton = await target.boundingBox()
    // The introduction never times out: it waits for Enter.
    await page.clock.runFor(4_000)
    await expect(help.locator(".guidance-text-visual")).toHaveText(lesson.kind === "do" ? lesson.help!.introduction![0]!.content : "")
    await page.keyboard.press("Enter")
    await expect(help.locator(".guidance-text-visual")).toHaveText("Press Command/Control+K anytime to open Chat and commands.")
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
    await page.clock.runFor(4_000)
    await expect(help.locator(".guidance-text-visual")).toHaveText("Press Command/Control+K anytime to open Chat and commands.")
    await help.getByRole("button", { name: "Next" }).click()
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
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-describedby", "guide-chat-help-1")
  await expect(page.locator("[data-help-pulse]")).toHaveCount(0)
  await page.keyboard.press("Enter")
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
  await expect.poll(painted, { timeout: 15_000 }).toBe("Smithers makes suggestions as to what we should do next as you use it.")
  await page.keyboard.press("Enter")
  await expect.poll(painted, { timeout: 15_000 }).toBe("Press Command/Control+K anytime to open Chat and commands.")
  await page.keyboard.press("Enter")
  await expect.poll(painted, { timeout: 15_000 }).toBe("Start with the practice repository’s issues. Click Show issues or press i.")
})
