import { expect, test } from "@playwright/test"

/*
 * M0 chat (LOCAL-APP.md): a turn typed into the composer is POSTed to the
 * local origin's /api/chat/turn and the streamed reply lands as an
 * assistant bubble, with no login. Runs against the stub
 * (SMITHERS_CHAT_STUB=1, the default).
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; chat.real.spec.ts covers the real endpoint")

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
test(`tutorial chat sends and displays the stub reply at ${viewport.width}px`, async ({ page }) => {
  await page.setViewportSize(viewport)
  await page.goto("/")
  await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '1')
  await page.keyboard.press('i')
  await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '2')
  const input = page.getByTestId("composer-input")
  await expect(input).toBeHidden()
  await page.keyboard.press("c")
  await expect(input).toBeVisible()
  await input.fill("say ok")
  await page.getByTestId("composer-send").click()
  await expect(input).toBeVisible()
  // The user's own bubble first, then the assistant's streamed text.
  await expect(page.locator(".guide-transcript .smithers-chat-message[data-role=\"user\"]")).toContainText("say ok")
  const assistant = page.locator(".guide-transcript .smithers-chat-message[data-role=\"assistant\"]", { hasText: "stub: say ok" })
  await expect(assistant).toContainText("stub: say ok", { timeout: 15_000 })
  await expect(assistant).toBeInViewport()
  await expect(input).toBeVisible()
  await expect(page.locator('.guide-shell')).toHaveAttribute('data-conversation-open', 'true')
})
}

test("typing 'say ok' and sending renders the stub reply", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Skip tutorial", exact: true }).click()
  const input = page.getByTestId("composer-input")
  await expect(input).toBeHidden()
  await page.keyboard.press("c")
  await expect(input).toBeVisible()
  await input.fill("say ok")
  await page.getByTestId("composer-send").click()
  // The user's own bubble first, then the assistant's streamed text.
  await expect(page.locator(".smithers-chat-message[data-role=\"user\"]")).toContainText("say ok")
  const assistant = page.locator(".smithers-chat-message[data-role=\"assistant\"]", { hasText: "stub: say ok" })
  await expect(assistant).toContainText("stub: say ok", { timeout: 15_000 })
})

for (const path of ["/", "/smithersai/smithers/"]) {
  test(`keyboard chat sends a turn and Shift+Enter inserts a newline: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
    await page.keyboard.press("c")
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
    const turn = page.waitForRequest(request => request.method() === "POST" && /\/api\/(?:agent|chat)\/turn(?:\?|$)/.test(request.url()))
    await input.press("Enter")
    await turn
    await expect(page.locator('.smithers-chat-message[data-role="assistant"]', { hasText: `stub: ${draft}` })).toContainText(`stub: ${draft}`, { timeout: 15_000 })
  })

  test(`Escape closes the slash menu before Chat: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
    await page.keyboard.press("c")
    const input = page.getByTestId("composer-input")
    await input.fill("/issues")
    await expect(page.getByTestId("palette")).toBeVisible()
    await input.press("Escape")
    await expect(page.getByTestId("palette")).toBeHidden()
    await expect(input).toBeFocused()
    await input.press("Escape")
    await expect(input).toBeHidden()
  })
}
