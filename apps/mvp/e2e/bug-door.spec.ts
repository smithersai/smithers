import { expect, test } from "./fixtures"
import { signedOut } from "./target"

test.use(signedOut)
for (const width of [1280, 390]) {
  test(`the repository bug-report door stays in Smithers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/smithersai/smithers")
    const link = page.getByRole("link", { name: "Report a bug", exact: true })
    const destination = await link.getAttribute("target") === "_blank"
      ? await Promise.all([page.waitForEvent("popup"), link.click()]).then(([popup]) => popup)
      : (await link.click(), page)
    await expect(destination).toHaveURL(/\/app\/bugs\/report$/)
    // bugs.md: a visitor signs in here, then reports; opening the door does not grant Send.
    const signIn = destination.getByRole("link", { name: "Sign in with GitHub", exact: true })
    await expect(signIn).toBeVisible({ timeout: 60_000 })
    await expect(signIn).toHaveAttribute("href", "/api/auth/sign-in?return=%2Fapp%2Fbugs%2Freport")
    await expect(destination.getByRole("button", { name: "Send", exact: true })).toHaveCount(0)
  })
}
