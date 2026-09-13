import { expect, type Page } from "@playwright/test"

/** Health scenarios use the current tutorial exit and existing session navigation. */
export const prepareHealthPage = async (page: Page, sidebar = false): Promise<void> => {
  const skip = page.getByRole("button", { name: "Skip tutorial", exact: true })
  await expect(skip).toBeVisible()
  await skip.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".guide-shell")).toHaveCount(0)
  if (sidebar) {
    const navigation = page.getByRole("button", { name: "Smithers", exact: true })
    await navigation.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("tab-add")).toBeVisible()
  }
}

export const sendHealthCommand = async (page: Page, command: string): Promise<void> => {
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.getByTestId("composer-input").press("Enter")
}
