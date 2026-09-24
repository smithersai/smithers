import { expect, test } from "@playwright/test"
import { signedOutVisitor } from "../playwright/identity"

// #1646: mounting the shell alone missed a missing knownRepositories action.
// Use the built Astro island and its real boot/controller/registry/storage;
// only HTTP responses are fixtures. The retired tutorial's replacement is
// the setup checklist and the first repository job.
for (const activation of ["click", "Enter"] as const) {
  test(`a fresh repository visitor can ${activation} the first setup action`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await signedOutVisitor(page)
    await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
    await page.route("**/api/repos/smithersai/smithers", route => route.fulfill({ json: { default_bookmark: "main" } }))
    await page.route("**/api/repos/smithersai/smithers/contents", route => route.fulfill({ json: [] }))
    const setupRequests: string[] = []
    await page.route("**/api/repository-setup/**", route => {
      setupRequests.push(route.request().url())
      return route.fulfill({ status: 401, json: { message: "Sign in" } })
    })

    // No seeded storage, direct controller invocation, or preliminary command:
    // this is the first human action after the production entry point boots.
    await page.goto("/smithersai/smithers/")
    const first = page.getByTestId("setup-checklist").getByRole("button", { name: "Set up a job", exact: true })
    await expect(first).toBeEnabled()
    if (activation === "click") await first.click()
    else {
      await first.focus()
      await expect(first).toBeFocused()
      await page.keyboard.press("Enter")
    }

    const setup = page.getByTestId("setup-issues")
    await expect(setup).toBeVisible()
    await expect(setup).toContainText("smithersai/smithers")
    await expect(setup.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
    // Command completion must leave Chat usable. Persistence/reload belongs
    // to the storage tier; WebKit private contexts can refuse OPFS entirely.
    await page.keyboard.press("Control+k")
    await expect(page.getByTestId("composer-input")).toBeFocused()
    await page.getByTestId("composer-input").press("Escape")
    await expect(page).toHaveURL("/smithersai/smithers/")
    expect(setupRequests).toEqual([])
    expect(errors).toEqual([])
  })
}
