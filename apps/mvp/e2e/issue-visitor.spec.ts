import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("a visitor can sign in from a public issue to comment", async ({ page }) => {
  requires("githubApp")
  await page.goto("/smithersai/smithers/issues/4432")
  await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: "#4432" })).toContainText("#4432", { timeout: 60_000 })
  await expect(page.getByRole("link", { name: "Sign in with GitHub", exact: true })).toHaveAttribute(
    "href", "/api/auth/sign-in?return=%2Fsmithersai%2Fsmithers%2Fissues%2F4432",
  )
})
