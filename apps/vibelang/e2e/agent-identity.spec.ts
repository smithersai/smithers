// Stays .ts: Playwright collects browser tests by JS/TS extension only.
import { expect, test } from "./coverage"

test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 4518}` })
test("the existing chat label names the signed-in person's agent in mock mode", async ({ page }) => {
  await page.goto("/e2e/actions-runtime/index.html?agent=yes")
  await page.getByRole("button", { name: "Minimize the VibeLang home page" }).click()
  const post = page.locator(".sui-chat-message[data-role='user']").filter({ hasText: "From the signed-in agent" })
  await expect(post.locator(".sui-chat-message-label")).toHaveText("will (agent)")
  await expect(page.getByRole("link", { name: "Mock mode: switch to live" })).toBeVisible()
})
