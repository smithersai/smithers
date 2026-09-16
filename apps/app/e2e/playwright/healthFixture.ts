import { expect, type Page } from "@playwright/test"

/** Open the app's existing session navigation. */
export const prepareHealthPage = async (page: Page, sidebar = false): Promise<void> => {
  await expect(page.locator(".app-shell")).toBeVisible()
  const dismiss = page.getByRole("button", { name: "Dismiss recommended actions", exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
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
