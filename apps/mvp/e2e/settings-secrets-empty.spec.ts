import { shapeRows } from "./shape"
import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("githubSignIn", "member", "emptySecretsRepository")
test("a Member's empty secret list names who can add secrets", async ({ page }) => {
  const repository = process.env.E2E_EMPTY_SECRETS_REPOSITORY!
  const role = await page.request.get(`/api/repos/${repository}/role`)
  expect(role.status()).toBe(200)
  expect(await role.json(), "the deployment's global role does not establish repository authority").toMatchObject({ own: true, role: "member" })
  const names = await shapeRows(page.request, `/api/shapes/secrets?repo=${encodeURIComponent(repository)}`)
  expect(names, "this must be a real empty secret list, never a repository-access refusal").toEqual([])
  await page.goto(`/${repository}/settings/secrets`)
  // An occupied list has no empty-state copy; this account must have no repository secrets for this check.
  await expect(page.getByText("No secrets · Admins add secrets", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toHaveCount(0)
})
