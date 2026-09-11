import { expect, test } from "@playwright/test"

/*
 * M0 chat (LOCAL-APP.md): a turn typed into the composer is POSTed to the
 * local origin's /api/chat/turn and the streamed reply lands as an
 * assistant bubble, with no login. Runs against the stub
 * (SMITHERS_CHAT_STUB=1, the default).
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; chat.real.spec.ts covers the real endpoint")

test("typing 'say ok' and sending renders the stub reply", async ({ page }) => {
  await page.goto("/")
  const input = page.getByTestId("composer-input")
  await expect(input).toBeVisible()
  await input.fill("say ok")
  await page.getByTestId("composer-send").click()
  // The user's own bubble first, then the assistant's streamed text.
  await expect(page.locator(".smithers-chat-message[data-role=\"user\"]")).toContainText("say ok")
  const assistant = page.locator(".smithers-chat-message[data-role=\"assistant\"]", { hasText: "stub: say ok" })
  await expect(assistant).toContainText("stub: say ok", { timeout: 15_000 })
})
