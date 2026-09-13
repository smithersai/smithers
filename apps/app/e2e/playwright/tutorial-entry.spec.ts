import { expect, test } from "@playwright/test"

test.use({ contextOptions: { reducedMotion: "reduce" } })

for (const width of [1280, 390]) {
  test(`welcome waits for Start tutorial and actions follow chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.clock.install()
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Start tutorial" })).toBeVisible()
    await page.clock.fastForward(10_000)
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "0")
    await expect(page.locator(".guide-dialogue > p")).toHaveText("I'm Smithers, I help your team manage your repository.")
    await expect(page.locator(".guide-actions button")).toHaveCount(1)
    await expect(page.locator(".guide-goal, .guide-navigation, .guide-practice-badge")).toHaveCount(0)
    await page.screenshot({ path: `/tmp/smithers-welcome-${width}.png` })
    await page.getByRole("button", { name: "Start tutorial" }).focus()
    await page.keyboard.press("Enter")
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
    await page.clock.runFor(1000)
    const last = await page.locator('.guide-dialogue[data-message-step="1"]').boundingBox()
    const action = await page.getByRole("button", { name: "Show issues" }).boundingBox()
    expect(last).not.toBeNull()
    expect(action).not.toBeNull()
    expect(action!.y - (last!.y + last!.height)).toBeGreaterThanOrEqual(0)
    expect(action!.y - (last!.y + last!.height)).toBeLessThan(50)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Dictation", exact: true })).toBeVisible()
    await page.screenshot({ path: `/tmp/smithers-actions-${width}.png` })
  })
}

test("dictation opens chat, appends recognized speech, and Escape releases the microphone", async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any
    host.SpeechRecognition = class {
      onresult: any; onerror: any; onend: any
      start() { host.dictation = this }
      stop() { this.onend?.() }
      abort() { host.dictationAborted = true }
    }
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Start tutorial" }).click()
  await page.getByRole("button", { name: "Dictation", exact: true }).click()
  const input = page.getByTestId("composer-input")
  await expect(input).toBeVisible()
  await input.fill("Please check")
  await page.evaluate(() => (window as any).dictation.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "the issue" } }] }))
  await expect(input).toHaveValue("Please check the issue")
  await expect(page.getByRole("dialog", { name: "Chat", exact: true }).getByRole("button", { name: "Stop dictation" })).toBeVisible()
  await page.screenshot({ path: "/tmp/smithers-dictation.png" })
  await page.keyboard.press("Escape")
  await expect(input).toBeHidden()
  expect(await page.evaluate(() => (window as any).dictationAborted)).toBe(true)
  await expect(page.getByRole("button", { name: "Dictation", exact: true })).toHaveAttribute("aria-pressed", "false")
})
