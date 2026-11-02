import { expect, test } from "./fixtures"
import { openAdd } from "./personal-model"
import { requires } from "./target"

test("model tier purposes are readable before entering credentials", async ({ page }) => {
  requires("member")
  await page.goto("/app/settings")
  const dialog = await openAdd(page.getByRole("region", { name: "Your model", exact: true }), page, "api_key")
  for (const [label, purpose] of [["Fast", "Chat"], ["Implement", "Coding"], ["Hard", "Plans and reviews"]]) {
    await expect(dialog.getByLabel(label!, { exact: true })).toHaveAccessibleDescription(purpose!)
  }
})

test("issues name their scheduling filter", async ({ page }) => {
  await page.goto("/smithersai/smithers/issues")
  const schedule = page.getByRole("navigation", { name: "Schedule", exact: true })
  await expect(schedule.getByText("Schedule", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(schedule.getByRole("link", { name: "Unscheduled", exact: true })).toBeVisible()
})

test("repository installation link opens the installation guide", async ({ page }) => {
  await page.goto("/smithersai/smithers")
  await expect(page.getByRole("link", { name: "Installation", exact: true })).toHaveAttribute("href", "https://smithers.sh/docs/installation/#install-the-cli", { timeout: 30_000 })
})
