import { expect, type Page } from "@playwright/test"

/** Route restoration and the chat panel arrive asynchronously after a reload. */
export const showChat = async (page: Page) => {
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  const chat = page.getByRole("button", { name: /^Chat\b/ })
  await expect.poll(async () => (await composer.isVisible()) || (await chat.isVisible()), { timeout: 30_000 }).toBe(true)
  if (!(await composer.isVisible())) await chat.click()
  await expect(composer).toBeVisible({ timeout: 30_000 })
  return composer
}
