import { expect, test } from "./fixtures"
import { requires } from "./target"

test("No commitment includes unlabeled issues", async ({ page }) => {
  requires("githubApp")
  await page.goto("/smithersai/smithers/issues?commitment=none")
  await expect(page.locator('[data-slot="issues-row"]').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("No issues", { exact: true })).toHaveCount(0)
})

for (const commitment of ["now", "next", "later"]) {
  test(`${commitment}: a synced empty filter shows its empty state`, async ({ page }) => {
    requires("githubApp")
    await page.goto("/smithersai/smithers/issues")
    await expect(page.locator('[data-slot="issues-row"]').first()).toBeVisible({ timeout: 60_000 })
    await page.getByRole("link", { name: commitment[0]!.toUpperCase() + commitment.slice(1), exact: true }).click()
    await expect(page.locator('[data-slot="issues-row"]').first().or(page.getByText("No issues", { exact: true }))).toBeVisible()
    await expect(page.locator('[data-list-sync]')).toHaveCount(0)
  })
}
