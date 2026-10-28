import { expect } from "@playwright/test"
import { firstRun, firstRunStep } from "./firstRun"
import { test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)
for (const width of [390, 1280]) test.describe(`${width}px visitor chrome`, () => {
  test.use({ viewport: { width, height: 844 } })
  test("chat has one sign-in action", async ({ page }) => {
    requires("githubSignIn")
    await page.goto("/app")
    // The first run's Sign in step offers it, and the header doesn't (decision 0121).
    await expect(firstRunStep(page, "Sign in")).toHaveAttribute("aria-current", "step")
    await expect(page.getByRole("link", { name: "Sign in with GitHub", exact: true })).toHaveCount(1)
    await expect(firstRun(page).getByRole("link", { name: "Sign in with GitHub", exact: true })).toHaveCount(1)
  })
})
