import { expect, test } from "./fixtures"

for (const [alias, canonical] of [
  ["/settings", "/app/settings"],
  ["/smithersai/smithers/secrets", "/smithersai/smithers/settings/secrets"],
  ["/smithersai/smithers/actions", "/smithersai/smithers/runs"],
]) {
  test(`compatibility URL opens its canonical page: ${alias}`, async ({ page }) => {
    await page.goto(alias)
    await expect(page).toHaveURL(new RegExp(`${canonical}$`))
    await expect(page.getByText("Not found", { exact: true })).toHaveCount(0)
  })
}

test("repository casing follows GitHub", async ({ page }) => {
  await page.goto("/SmithersAI/SMITHERS")
  await expect(page).toHaveURL(/\/smithersai\/smithers$/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("smithersai / smithers")
})

test("a tree URL naming a real file opens its blob", async ({ page }) => {
  await page.goto("/smithersai/smithers/tree/main/README.md")
  await expect(page).toHaveURL(/\/smithersai\/smithers\/blob\/main\/README.md$/)
  await expect(page.getByText("Not found", { exact: true })).toHaveCount(0)
})
