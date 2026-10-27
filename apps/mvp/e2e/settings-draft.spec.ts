import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("personalModel", "member")
test.use({ trace: "off" })

test("Test refuses malformed and unsaved model drafts without calling the saved model", async ({ page }) => {
  await page.goto("/app/settings")
  const section = page.getByRole("region", { name: "Your model" })
  const button = section.getByRole("button", { name: "Test", exact: true })
  await expect(button).toBeVisible()
  const group = section.getByRole("group", { name: "OpenAI-compatible", exact: true })
  const base = group.locator('input[name="baseUrl:openai-chat"]')
  const key = group.locator('input[name="key:openai-chat"]')
  let calls = 0
  page.on("request", (request) => {
    if (request.url().endsWith("/api/me/model/test")) calls++
  })
  for (const value of ["not a url", "https://exa mple.test/v1"]) {
    await base.fill(value)
    await button.click()
    await expect(section.getByRole("status")).toHaveText("Base URLs are https:// on a public host, with no port")
  }
  await base.fill("https://api.openai.com")
  await key.fill("sk-unsaved-test-draft")
  await button.click()
  await expect(section.getByRole("status")).toHaveText("Save first")
  for (const input of await section.locator('input[name^="baseUrl:"], input[type="password"]').all()) await input.fill("")
  await button.click()
  await expect(section.getByRole("status")).toHaveText("Your model wasn't saved")
  expect(calls).toBe(0)
})
