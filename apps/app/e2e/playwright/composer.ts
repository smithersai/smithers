import { expect, type Page } from "@playwright/test"

/** Use the visible Chat door before typing into the closed-by-default composer. */
export const fillComposer = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await expect(input).toBeVisible()
  await input.fill(text)
}
