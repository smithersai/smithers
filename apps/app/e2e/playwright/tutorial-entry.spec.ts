import { expect,test } from "@playwright/test"

test.use({ contextOptions: { reducedMotion: "reduce" } })


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
  await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
  await page.keyboard.press("m")
  await page.getByRole("menuitemradio", { name: "Dictation", exact: true }).click()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("Meta+k")
  const input = page.getByTestId("composer-input")
  await expect(input).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop dictation" })).toBeVisible()
  await input.fill("Please check")
  await page.evaluate(() => (window as any).dictation.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "the issue" } }] }))
  await expect(input).toHaveValue("Please check the issue")
  await expect(page.getByRole("dialog", { name: "Chat", exact: true }).getByRole("button", { name: "Stop dictation" })).toBeVisible()
  const stop = page.getByRole("button", { name: "Stop dictation" })
  await expect(stop).toHaveAttribute("aria-keyshortcuts", "Escape")
  // Stop precedes the input in the nonmodal dock's native tab order.
  await input.press("Shift+Tab")
  await expect(stop).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(input).toBeFocused()
  await page.screenshot({ path: "/tmp/smithers-dictation.png" })
  await page.keyboard.press("Escape")
  // Capture owns the first Escape; the next closes Chat and its root palette.
  expect(await page.evaluate(() => (window as any).dictationAborted)).toBe(true)
  await expect(page.getByRole("button", { name: "Stop dictation" })).toHaveCount(0)
  await expect(input).toBeVisible()
  await expect(input).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Escape")
  await expect(input).toBeHidden()
  await expect(page.getByRole("button", { name: "Mode: Dictation", exact: true })).toBeVisible()
})


test("dictation Stop is reachable by Shift+Tab and Enter without closing Chat", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).SpeechRecognition = class {
      onend: any
      start() {}
      stop() { this.onend?.() }
      abort() {}
    }
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Mode: Normal", exact: true }).click()
  await page.getByRole("menuitemradio", { name: "Dictation", exact: true }).click()
  await page.keyboard.press("Meta+k")
  // Chat opens before recognition starts; test Shift+Tab once capture offers Stop.
  await expect(page.getByRole("button", { name: "Stop dictation" })).toBeVisible()
  await page.getByTestId("composer-input").press("Shift+Tab")
  await expect(page.getByRole("button", { name: "Stop dictation" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Stop dictation" })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await expect(page.getByRole("dialog", { name: "Chat", exact: true })).toBeVisible()
})

