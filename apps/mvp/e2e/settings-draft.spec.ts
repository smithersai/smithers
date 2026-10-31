import { expect, test } from "./fixtures"
import { openAdd } from "./personal-model"
import { requires } from "./target"

requires("personalModel", "member")
test.use({ trace: "off" })

test("Add refuses a malformed connection on the tab, sending nothing", async ({ page }) => {
  await page.goto("/app/settings")
  const section = page.getByRole("region", { name: "Your model" })
  await expect(section).toBeVisible({ timeout: 30_000 })
  let puts = 0
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/me/model") puts++
  })
  const dialog = await openAdd(section, page, "api_key")
  const base = dialog.getByLabel("Base URL", { exact: true })
  const save = dialog.getByRole("button", { name: "Save" })
  for (const value of ["not a url", "https://exa mple.test/v1"]) {
    await base.fill(value)
    await save.click()
    await expect(dialog.getByRole("status")).toHaveText("Base URLs are https:// on a public host, with no port")
  }
  await base.fill("https://api.openai.com")
  await save.click()
  await expect(dialog.getByRole("status")).toHaveText("Enter the key")
  expect(puts).toBe(0)
})
