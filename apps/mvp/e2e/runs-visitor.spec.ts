import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

requires("githubSignIn")
test.use(signedOut)
test("repository runs: a visitor sees a sign-in path", async ({ page }) => {
  await page.goto("/smithersai/smithers/actions")
  await expect(page.getByRole("main", { name: "Runs", exact: true }).getByRole("link", { name: "Sign in with GitHub" })).toBeVisible()
})
