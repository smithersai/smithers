import { expect, test } from "./fixtures"

test.use({ storageState: { cookies: [], origins: [] } })
for (const width of [1280, 390]) {
  test(`the repository bug-report door stays in Smithers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/smithersai/smithers")
    const link = page.getByRole("link", { name: "Report a bug", exact: true })
    const destination = await link.getAttribute("target") === "_blank"
      ? await Promise.all([page.waitForEvent("popup"), link.click()]).then(([popup]) => popup)
      : (await link.click(), page)
    await expect(destination).toHaveURL(/\/app\/bugs\/report$/)
    await expect(destination.getByRole("form", { name: "Report a bug" })).toBeVisible()
  })
}
