import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("githubApp")
for (const [path, title, list, name] of [
  ["/smithersai/smithers/issues/999999", "Issue not found", "/smithersai/smithers/issues", "Issues"],
  ["/smithersai/smithers/pull/999999", "Pull request not found", "/smithersai/smithers/pulls", "Pull requests"],
]) {
  test(`absent item names its resource and list: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByText(title!, { exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole("main").getByRole("link", { name: name!, exact: true }).last()).toHaveAttribute("href", list!)
  })
}
test("an unsynced repository's item settles with its source link", async ({ page }) => {
  await page.goto("/smithersai/smithers-infra/issues/1")
  await expect(page.getByText("Issue unavailable here", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("link", { name: "Open on GitHub ↗", exact: true })).toHaveAttribute("href", "https://github.com/smithersai/smithers-infra/issues/1")
})
