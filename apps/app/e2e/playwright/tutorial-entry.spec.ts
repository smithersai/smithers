import { expect, test } from "@playwright/test"

test.use({ contextOptions: { reducedMotion: "reduce" } })

test("the homepage's new-tab destination opens the tutorial directly", async ({ page }) => {
  await page.goto("/smithersai/smithers/?tutorial")
  await expect(page.getByRole("button", { name: "Show issues", exact: true })).toBeVisible()
  await expect(page.getByRole("note", { name: "Help" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Start tutorial", exact: true })).toHaveCount(0)
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await page.keyboard.press("i")
  await expect(page.getByRole("button", { name: "Read issue #3", exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Read issue #3", exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.has("tutorial")).toBe(true)
})

for (const width of [1280, 390]) {
  test(`entry opens practice without a second start at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.clock.install()
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Start tutorial" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Show issues" })).toBeVisible()
    await expect(page.getByRole("note", { name: "Help" })).toBeVisible()
    await page.clock.fastForward(10_000)
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
    await expect(page.locator(".guide-back:not(.guide-skip), [data-testid=card-practice-repo]")).toHaveCount(0)
    await page.clock.runFor(1000)
    await expect(page.locator(".guide-message, .guide-dialogue, .guide-speaker")).toHaveCount(0)
    const goal = await page.getByRole("region", { name: "Goal", exact: true }).boundingBox()
    const action = await page.getByRole("button", { name: "Show issues" }).boundingBox()
    expect(goal).not.toBeNull()
    expect(action).not.toBeNull()
    expect(action!.y - (goal!.y + goal!.height)).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
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
  await page.keyboard.press("m")
  await page.getByRole("menuitemradio", { name: "Dictation", exact: true }).click()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("c")
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
  await expect(page.getByRole("button", { name: "Mode: Dictation", exact: true })).toBeVisible()
})
