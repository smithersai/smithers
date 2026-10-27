import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member")
for (const line of ["/issue nonrepo title", "/clone nope"]) {
  test(`slash command: ${line} stays available for correction`, async ({ page }) => {
    await page.goto("/app")
    await page.getByRole("button", { name: /^Chat/ }).click()
    const composer = page.locator("textarea").first()
    await composer.fill(line)
    await composer.press("Enter")
    await expect(composer).toHaveValue(line)
    await expect(page.getByText(`/${line.split(" ")[0]!.slice(1)} needs owner/name`, { exact: true })).toBeVisible()
    await expect(composer).toBeEnabled()
  })
}
