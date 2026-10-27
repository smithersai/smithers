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
