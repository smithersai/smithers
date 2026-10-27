import { expect, test } from "./fixtures"
import { requires } from "./target"

// Read-only production regression: no merge, approval, sign-out or GitHub write.
test("issue and pull detail pages retain their list and title", async ({ page }) => {
  requires("githubApp")
  await page.goto("/smithersai/smithers/issues/4432")
  await expect(page.getByRole("heading", { level: 1 })).toContainText("#4432", { timeout: 60_000 })
  await expect(page.getByRole("link", { name: "Issues", exact: true })).toHaveAttribute("href", "/smithersai/smithers/issues")
  await page.goto("/smithersai/smithers/pull/4436")
  const heading = page.getByRole("heading", { level: 1 })
  await expect(heading).toContainText("#4436", { timeout: 60_000 })
  const title = await heading.innerText()
  for (const tab of ["Checks", /^Commits/, /^Files/]) {
    await page.getByRole("link", { name: tab }).click()
    await expect(heading).toHaveText(title)
    await expect(page.getByRole("link", { name: "Pull requests", exact: true })).toHaveAttribute("href", "/smithersai/smithers/pulls")
  }
})
