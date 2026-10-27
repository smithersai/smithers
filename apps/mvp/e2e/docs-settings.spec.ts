import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("settings guide: visitors can find member and Admin controls", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/settings/")
  await expect(page.getByRole("heading", { level: 1, name: "Settings", exact: true })).toBeVisible()
  for (const name of ["Your model", "Spend alerts", "Sandboxes"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
  await expect(page.locator(".sl-markdown-content").getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", /\/app\/settings$/)
  const copy = await page.request.get("/docs/settings.md")
  expect(copy.status()).toBe(200)
  expect(await copy.text()).toContain("Monthly alert ($)")
})
