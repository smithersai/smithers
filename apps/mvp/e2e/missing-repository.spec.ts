import { repositoryAbout } from "./repository-prerequisites"
import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"
import { expectServerError } from "./watch"

test.use(signedOut)

test("a missing repository offers no clone or feature navigation", async ({ page }) => {
  requires("codeStorage", "absentRepository")
  const repository = await repositoryAbout("absentRepository")
  expectServerError(404, `/api/repos/${repository}/about`)
  await page.goto(`/${repository}`)
  await expect(page.getByText("Repository not found", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("link", { name: "Sign in to clone", exact: true })).toHaveCount(0)
  for (const name of ["Issues", "Pull requests", "Runs", "Stack"]) {
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0)
  }
})

test("the named absent repository has a recovery link", async ({ page }) => {
  requires("codeStorage", "absentRepository")
  const repository = await repositoryAbout("absentRepository")
  expectServerError(404, `/api/repos/${repository}/about`)
  await page.goto(`/${repository}`)
  await expect(page.getByText("Repository not found", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("link", { name: "Back to chat", exact: true }).last()).toHaveAttribute("href", "/app")
})
