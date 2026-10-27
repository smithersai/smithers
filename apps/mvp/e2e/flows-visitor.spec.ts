import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

requires("githubSignIn")
test.use(signedOut)
test("flows: a visitor can sign in to create a flow", async ({ page }) => {
  await page.goto("/app/flows")
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New flow" })).toHaveCount(0)
})
