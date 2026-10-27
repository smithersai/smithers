import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)
for (const width of [390, 1280]) test.describe(`${width}px visitor chrome`, () => {
  test.use({ viewport: { width, height: 844 } })
  test("chat has one sign-in action", async ({ page }) => {
    requires("githubSignIn")
    await page.goto("/app")
    await expect(page.getByText("Sign in to ask Smithers.", { exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: "Sign in with GitHub", exact: true })).toHaveCount(1)
  })
})
