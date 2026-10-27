import { expect, test } from "./fixtures"

test.use({ storageState: { cookies: [], origins: [] } })
for (const path of ["/app/settings", "/smithersai/smithers/settings", "/smithersai/smithers/settings/secrets"]) {
  test(`visitor settings offers sign-in: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole("link", { name: "Sign in with GitHub", exact: true })).toHaveAttribute("href", `/api/auth/sign-in?return=${encodeURIComponent(path)}`)
  })
}
