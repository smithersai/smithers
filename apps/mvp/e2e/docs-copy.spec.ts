import { expect, test } from "./fixtures"
import { requires } from "./target"

test("model tier purposes are readable before entering credentials", async ({ page }) => {
  requires("member")
  await page.goto("/app/settings")
  const section = page.getByRole("region", { name: "Your model", exact: true })
  for (const [label, purpose] of [["Fast", "Chat"], ["Implement", "Coding"], ["Hard", "Plans and reviews"]]) {
    await expect(section.getByLabel(label!, { exact: true })).toHaveAccessibleDescription(purpose!)
  }
})

test("issues name their scheduling filter", async ({ page }) => {
  await page.goto("/smithersai/smithers/issues")
  const schedule = page.getByRole("navigation", { name: "Schedule", exact: true })
  await expect(schedule.getByText("Schedule", { exact: true })).toBeVisible()
  await expect(schedule.getByRole("link", { name: "Unscheduled", exact: true })).toBeVisible()
})

test("repository installation link opens the installation guide", async ({ page }) => {
  await page.goto("/smithersai/smithers")
  await expect(page.getByRole("link", { name: "Install Smithers", exact: true })).toHaveAttribute("href", "https://smithers.sh/docs/installation/")
})
