import { expect, type Page } from "@playwright/test"

/** Wait for the app's shell and clear the first-run card. */
export const prepareHealthPage = async (page: Page): Promise<void> => {
  await expect(page.locator(".app-shell")).toBeVisible()
  const dismiss = page.getByRole("button", { name: "Dismiss recommended actions", exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
}

export const sendHealthCommand = async (page: Page, command: string): Promise<void> => {
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.getByTestId("composer-input").press("Enter")
}
