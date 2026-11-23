import { expect, test } from "./fixtures"
import { signedOut } from "./target"
import { expectServerError } from "./watch"

test.use(signedOut)

test("visiting a GitHub user profile shows their profile and repositories", async ({ page }) => {
  await test.step("Open profile page", async () => {
    await page.goto("/roninjin10")
    await expect(page.getByRole("main", { name: "Profile" })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-slot="owner-profile"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(".sui-profile-login")).toHaveText("roninjin10")
  })

  await test.step("Switch to Repositories tab and search", async () => {
    await page.getByRole("navigation", { name: "Profile sections" }).getByRole("link", { name: /^Repositories/ }).click()
    await expect(page).toHaveURL(/\/roninjin10\?tab=repositories/)
    const search = page.getByRole("searchbox", { name: "Find a repository" })
    await expect(search).toBeVisible()
    await search.fill("nonexistent-repo-xyz-99999")
    await expect(page.getByText("No matching repositories")).toBeVisible()
    await page.getByRole("button", { name: "Clear filter" }).click()
    await expect(search).toHaveValue("")
  })
})

test("a missing GitHub profile shows Profile not found", async ({ page }) => {
  const absent = "smithers-absent-profile-e2e-000000"
  expectServerError(404, `/api/profiles/${absent}`)
  await page.goto(`/${absent}`)
  await expect(page.getByText("Profile not found", { exact: true })).toBeVisible({ timeout: 30_000 })
})
