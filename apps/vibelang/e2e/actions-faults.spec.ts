// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// The Actions list fails once from a faulty Actions service over the real MockActions (test/support/FaultyActions.vibe).
import { expect, test } from "./coverage"

test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}` })

test("a failed Actions list offers Retry, then a Post run takes its typed message", async ({ page }) => {
  await page.goto("/e2e/actions-runtime/index.html?role=contributor&fault=actions")
  await page.keyboard.press("ControlOrMeta+k")
  const input = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
  await input.fill("Hello")
  await input.press("Enter")
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  const pane = page.getByRole("region", { name: "Actions", exact: true })
  const alert = pane.getByRole("alert").filter({ hasText: "Couldn't load runs" })
  await expect(alert).toBeVisible()
  await alert.getByRole("button", { name: "Retry" }).click()
  await expect(alert).toHaveCount(0)
  await pane.getByRole("button", { name: "Post", exact: true }).click()
  const message = pane.getByRole("textbox", { name: "Action input" })
  await message.fill("From the Actions pane")
  await expect(message).toHaveValue("From the Actions pane")
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  await expect(page.getByRole("button", { name: /Open Post run/ })).toBeVisible()
})
