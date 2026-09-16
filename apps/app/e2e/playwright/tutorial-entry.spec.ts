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

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`repository Home heading remains visible on first paint at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.route('**/api/bootstrap', route => route.fulfill({ json: {
      apiVersion: 1, host: 'cloud', version: 'test', buildSha: 'test', capabilities: ['identity', 'cloud'], authFlow: 'redirect', sandbox: null,
    } }))
    await page.route('**/api/auth/session', route => route.fulfill({ json: { status: 'signed-in', login: 'tutorial-user', allowlisted: true, admin: false } }))
    await page.route('**/api/public/repos', route => route.fulfill({ json: { repos: [{ name: 'smithersai/smithers' }] } }))
    await page.route('**/api/repos/smithersai/smithers', route => route.fulfill({ json: { default_bookmark: 'main' } }))
    await page.route('**/contents/.smithers/home.json', route => route.fulfill({ json: {
      type: 'file', encoding: 'utf-8', content: JSON.stringify({ blocks: [{ type: 'text', text: 'Home introduction. ' + 'A long repository description. '.repeat(70) }] }),
    } }))
    await page.goto('/smithersai/smithers')
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.keyboard.press('Meta+k')
    await page.getByTestId('composer-input').fill('/repo.home smithersai/smithers')
    await page.keyboard.press('Enter')
    const heading = page.locator('[data-kind="repo-home"] .smithers-card-title')
    await expect(heading).toBeVisible()
    await page.keyboard.press('Escape')
    await page.reload()
    await expect(heading).toBeInViewport()
    // The inactive control is inert, so it is excluded from the accessibility tree.
    await expect(page.getByRole('button', { name: "Jump to latest", includeHidden: true })).toHaveAttribute("data-active", "false")
  })
}

for (const chord of ['Control+k', 'Meta+k']) test(`${chord} opens only the dock, resizes the workspace, and closes to Chat`, async ({ page }) => {
  await page.goto('/?tutorial')
  const content = page.locator('.guide-content')
  const before = (await content.boundingBox())!
  await page.keyboard.press(chord)
  const input = page.getByTestId('composer-input')
  await expect(input).toBeFocused()
  const dock = page.getByRole('dialog', { name: 'Chat', exact: true })
  await expect(dock).toHaveAttribute('aria-modal', 'false')
  const after = (await content.boundingBox())!
  const dockBox = (await dock.boundingBox())!
  expect(after.height).toBeLessThan(before.height)
  expect(after.y + after.height).toBeLessThanOrEqual(dockBox.y)
  await page.keyboard.press(chord)
  await expect(input).toBeHidden()
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeFocused()
  expect((await content.boundingBox())!.height).toBe(before.height)
})
