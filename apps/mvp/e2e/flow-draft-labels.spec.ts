import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("member", "duplicateDrafts")
test("flows: duplicate draft names expose distinct requests and Delete names", async ({ page }) => {
  const name = process.env.E2E_DUPLICATE_DRAFT_NAME
  await page.goto("/app/flows")
  const rows = page.getByRole("table", { name: "Drafts", exact: true }).getByRole("row").filter({ hasText: name! })
  await expect(rows).toHaveCount(2, { timeout: 30_000 })
  const links = await rows.getByRole("link").allTextContents()
  expect(new Set(links).size).toBe(2)
  for (let index = 0; index < 2; index++) {
    await expect(rows.nth(index).getByRole("button", { name: `Delete draft ${links[index]}` })).toBeVisible()
  }
})
