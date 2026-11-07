import { expect, test } from "@playwright/test"

// The live agent in a real browser (wiki/decisions/0010-live-agent.md), opt in: `E2E_LIVE_URL` names a deployment or
// a local `alchemy dev` (http://localhost:1337) whose API Worker is bound. The page must choose the live Factory, and
// a question must get a reply that settles: an answer from the deployment's model, or the agent's reason it can't
// (no model key, a spent budget). With `E2E_LIVE_ANSWERS=1` the model is configured and the reply must be an answer.
// Every other browser suite runs the mock (VL-13).
const live = process.env.E2E_LIVE_URL

test.describe("the live agent", () => {
  test.skip(live === undefined, "set E2E_LIVE_URL to a live deployment or alchemy dev")
  test.use({ storageState: { cookies: [], origins: [] } })

  test("a visitor asks and the live agent's reply settles, with no Mock pill", async ({ page }, testInfo) => {
    await page.goto(new URL("/", live).toString())
    await expect(page.getByRole("heading", { name: "VibeLang" })).toBeVisible()
    await expect(page.getByText("Mock", { exact: true })).toHaveCount(0)
    await page.keyboard.press("ControlOrMeta+k")
    await page.getByRole("textbox", { name: "Message" }).pressSequentially("How do I declare a service?")
    await page.keyboard.press("Enter")
    const answer = page.locator(".sui-chat-message[data-role='assistant']").last()
    await expect(answer).toHaveAttribute("data-done", "true", { timeout: 120_000 })
    if (process.env.E2E_LIVE_ANSWERS === "1") {
      await expect(answer.locator(".vl-error")).toHaveCount(0)
      await expect(answer).toContainText("service")
    }
    await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
    await page.screenshot({ path: testInfo.outputPath("live.png") })
  })
})
