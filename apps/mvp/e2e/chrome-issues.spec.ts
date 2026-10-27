import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires, syncedRepository } from "./target"

for (const width of [390, 1280]) test.describe(`${width}px issues chrome`, () => {
  test.use({ viewport: { width, height: 844 } })
  test("issues has one way back", async ({ page }) => {
    requires("githubApp", "syncedRepository")
    await page.goto(`/${syncedRepository()}/issues`)
    await expect(page.getByRole("heading", { name: new RegExp(syncedRepository().replace("/", " / ")) })).toBeVisible()
    await expect(page.getByRole("link", { name: "Back to chat", exact: true })).toHaveCount(1)
  })
})
