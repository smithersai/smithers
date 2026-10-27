import { expect, test } from "./fixtures"
import { requires } from "./target"

for (const list of ["issues", "pulls"]) {
  test(`${list}: search and sort are shareable and survive reload`, async ({ page }) => {
    requires("githubApp")
    await page.goto(`/smithersai/smithers/${list}`)
    await expect(page.locator('[data-slot="issues-row"]').first()).toBeVisible({ timeout: 60_000 })
    const title = await page.locator('.sui-issues-title').first().innerText()
    await page.getByRole("textbox", { name: `Search ${list}` }).fill(title)
    await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("oldest")
    await expect(page).toHaveURL(/sort=oldest/)
    await page.reload()
    await expect(page.getByRole("textbox", { name: `Search ${list}` })).toHaveValue(title)
    await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("oldest")
    await expect(page.locator('.sui-issues-title').first()).toHaveText(title)
    await page.getByRole("textbox", { name: `Search ${list}` }).fill("bugbash3-bb2-lists-no-matching-issue")
    await expect(page.getByText(list === "issues" ? "No issues" : "No pull requests", { exact: true })).toBeVisible()
  })
}
