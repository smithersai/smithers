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
