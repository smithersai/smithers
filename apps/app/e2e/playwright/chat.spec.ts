import { expect,test,type Page } from "@playwright/test"

// IntersectionObserver alone accepts bubbles covered by a fixed scrim.
const expectReadableTurn = async (page: Page, text: string) => {
  const dock = page.getByRole('dialog', { name: 'Chat' })
  const transcript = page.locator('.smithers-transcript')
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


test("typing 'say ok' and sending renders the stub reply", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Dismiss recommended actions", exact: true }).click()
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
    for (const draft of ['/account.show', '/wiki']) {
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


