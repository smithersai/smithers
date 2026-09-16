import { expect, test, type Page } from "@playwright/test"

// IntersectionObserver alone accepts bubbles covered by a fixed scrim.
const expectReadableTurn = async (page: Page, text: string) => {
  const dock = page.locator('.guide-composer-dock')
  const transcript = page.getByRole('log', { name: 'Onboarding chat history' })
  for (const role of ['user', 'assistant']) {
    const bubble = transcript.locator(`.smithers-chat-message[data-role="${role}"]`, { hasText: text }).last()
    await expect(bubble).toBeInViewport({ ratio: 1 })
    await expect.poll(async () => {
      const box = (await bubble.boundingBox())!
      return box.y + box.height <= (await dock.boundingBox())!.y
    }).toBe(true)
    expect(await bubble.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
  }
  expect(await dock.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
  expect(await transcript.evaluate(element => element.closest('[inert]') === null)).toBe(true)
}

test.use({ actionTimeout: 3_000, navigationTimeout: 10_000 })
test.setTimeout(30_000)

/*
 * M0 chat (LOCAL-APP.md): a turn typed into the composer is POSTed to the
 * local origin's /api/chat/turn and the streamed reply lands as an
 * assistant bubble, with no login. Runs against the stub
 * (SMITHERS_CHAT_STUB=1, the default).
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; chat.real.spec.ts covers the real endpoint")

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
for (const theme of ["light", "dark"] as const) {
test(`tutorial chat sends and displays the stub reply at ${viewport.width}px (${theme})`, async ({ page }) => {
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: theme })
  await page.goto("/")
  await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '1')
  await page.keyboard.press('i')
  await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '2')
  const input = page.getByTestId("composer-input")
  await expect(input).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(input).toBeVisible()
  await input.fill("say ok")
  await page.getByTestId("composer-send").click()
  await expect(input).toBeVisible()
  // The user's own bubble first, then the assistant's streamed text.
  await expect(page.locator(".guide-transcript .smithers-chat-message[data-role=\"user\"]")).toContainText("say ok")
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
  const colours = await page.locator('.guide-transcript .smithers-chat-message[data-role="user"]').evaluate(element => ({
    text: getComputedStyle(element.querySelector('.sui-md-p')!).color,
    background: getComputedStyle(element.querySelector('.sui-chat-bubble')!).backgroundColor,
  }))
  expect(colours.text).not.toBe(colours.background)
  const assistant = page.locator(".guide-transcript .smithers-chat-message[data-role=\"assistant\"]", { hasText: "stub: say ok" })
  await expect(assistant).toContainText("stub: say ok", { timeout: 5_000 })
  await expectReadableTurn(page, "say ok")
  await expect(input).toBeVisible()
  await expect(page.locator('.guide-shell')).toHaveAttribute('data-conversation-open', 'true')
})
}
}

test("typing 'say ok' and sending renders the stub reply", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Skip tutorial", exact: true }).click()
  const input = page.getByTestId("composer-input")
  await expect(input).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(input).toBeVisible()
  await input.fill("say ok")
  await page.getByTestId("composer-send").click()
  // The user's own bubble first, then the assistant's streamed text.
  await expect(page.locator(".smithers-chat-message[data-role=\"user\"]")).toContainText("say ok")
  const assistant = page.locator(".smithers-chat-message[data-role=\"assistant\"]", { hasText: "stub: say ok" })
  await expect(assistant).toContainText("stub: say ok", { timeout: 5_000 })
})

for (const path of ["/", "/smithersai/smithers/"]) {
  test(`Chat button preserves immediately typed slash prefixes on every open: ${path}`, async ({ page }) => {
    await page.goto(path)
    const input = page.getByTestId('composer-input')
    for (const draft of ['/account.show', '/wiki', '/factory.show']) {
      await page.getByRole('button', { name: 'Chat', exact: true }).click()
      await page.keyboard.type(draft)
      await expect(input).toHaveValue(draft)
      await expect(page.locator('.session-sidebar')).toHaveCount(0)
      await input.fill('')
      await page.keyboard.press('Escape')
      await expect(input).toBeHidden()
    }
  })

  test(`/help displays an unknown-flow refusal and keeps the draft: ${path}`, async ({ page }) => {
    let turns = 0
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:agent|chat)\/turn/.test(request.url())) turns++ })
    await page.goto(path)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.keyboard.type('/help')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('palette')).toContainText('There is no /help flow.')
    await expect(page.getByTestId('composer-input')).toHaveValue('/help')
    expect(turns).toBe(0)
  })

  test(`keyboard chat sends a turn and Shift+Enter inserts a newline: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
    await page.keyboard.press("Meta+k")
    const input = page.getByTestId("composer-input")
    await expect(input).toBeFocused()
    await expect(page.getByTestId("palette")).toBeVisible()
    await input.press("Enter")
    await expect(input).toBeFocused()
    await expect(page.locator('.smithers-chat-message[data-role="user"]')).toHaveCount(0)
    await input.fill("First line")
    await input.press("Shift+Enter")
    await expect(input).toHaveValue("First line\n")
    await expect(page.getByTestId("palette")).toBeVisible()

    const draft = "What does this repository do? Answer in two sentences."
    await input.fill(draft)
    const turn = page.waitForRequest(request => request.method() === "POST" && /\/api\/(?:agent|chat)\/turn(?:\?|$)/.test(request.url()), { timeout: 5_000 })
    await input.press("Enter")
    await turn
    const reply = page.locator('.smithers-chat-message[data-role="assistant"]', { hasText: `stub: ${draft}` })
    await expect(reply).toContainText(`stub: ${draft}`, { timeout: 5_000 })
    await expect(page.locator('.smithers-chat-message[data-role="user"]', { hasText: draft })).toBeInViewport({ ratio: 1 })
    await expect(reply).toBeInViewport({ ratio: 1 })
    if (path === "/") await expectReadableTurn(page, draft)
  })

  test(`Escape closes Chat and its root palette and restores the draft on reopen: ${path}`, async ({ page }) => {
    await page.goto(path)
    const chat = page.getByRole('button', { name: 'Chat', exact: true })
    await chat.click()
    const input = page.getByTestId('composer-input')
    await input.fill('keep this draft')
    await expect(page.getByTestId('palette')).toBeVisible()
    await input.press('Escape')
    await expect(input).toBeHidden()
    if (path === "/") await expect(chat).toBeFocused()
    await expect(page.getByTestId('palette')).toBeHidden()
    await chat.click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('keep this draft')
  })

  for (const draft of ['/issues', '/issues.']) test(`Escape closes the slash menu for ${draft} before Chat: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
    await page.keyboard.press("Meta+k")
    const input = page.getByTestId("composer-input")
    await input.fill(draft)
    await expect(page.getByTestId("palette")).toBeVisible()
    await input.press("Escape")
    await expect(page.getByTestId("palette")).toBeHidden()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(draft)
    await input.press("Escape")
    await expect(input).toBeHidden()
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(input).toHaveValue(draft)
  })
}


for (const query of ["/", "m"]) for (const height of [800, 600]) test(`practice palette has room for whole rows for ${query} at ${height}px`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height })
  await page.goto("/smithersai/smithers/?tutorial")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  expect(new URL(page.url()).search).toBe("?tutorial")
  await page.keyboard.press("i")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
  expect(new URL(page.url()).search).toBe("?tutorial")
  await page.keyboard.press("Meta+k")
  await page.getByTestId("composer-input").fill(query)
  const palette = page.getByTestId("palette")
  await expect(palette.getByRole("option").nth(5)).toBeAttached()
  await expect.poll(() => palette.evaluate(node => {
    const body = node.querySelector(".slash-menu-body")!.getBoundingClientRect()
    const rows = [...node.querySelectorAll('[role="option"]')].map(row => row.getBoundingClientRect())
    return rows.filter(row => row.top >= body.top && row.bottom <= body.bottom).length
  // A bottom dock shares short windows with the transcript; suggestions scroll.
  })).toBeGreaterThanOrEqual(height === 600 ? 3 : 5)
  const body = palette.locator(".slash-menu-body")
  expect(await body.evaluate(node => getComputedStyle(node).overflowY)).toBe("auto")
  await body.evaluate(node => { node.scrollTop = node.scrollHeight })
  await expect(palette.getByRole('option').last()).toBeInViewport({ ratio: 1 })
  await expect(palette.locator(".palette-foot")).toBeInViewport({ ratio: 1 })
})


for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`the chat lesson keeps the exchange visible through its terminal beat at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/?tutorial')
    await page.getByRole('button', { name: 'Skip tutorial', exact: true }).click()
    await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '10')
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '13')
    await page.keyboard.press('Meta+k')
    await page.getByTestId('composer-input').fill('say ok')
    await page.getByTestId('composer-input').press('Enter')
    await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '14')
    await expect(page.locator('.guide-transcript [data-role="assistant"]')).toContainText('stub: say ok')
    await expectReadableTurn(page, 'say ok')
  })
}
