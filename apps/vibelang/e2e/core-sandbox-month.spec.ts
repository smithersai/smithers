// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// fault=sandbox-month-end (test/support/FaultyFactory.vibe): the first start leaves five minutes; once the person stops,
// the meter's clock moves to three seconds before the next UTC month. The sandbox started again runs across the month's
// end: the meter splits the interval at the boundary (sandboxDecision.vibe `meterStep`), the new month's allowance is
// whole again, and the old month's low notice clears.
import { expect, test } from "./coverage"

test("a sandbox running when the month ends gets the new month's minutes, and the low notice clears", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?agent=mock&fault=sandbox-month-end")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  const status = page.getByRole("status", { name: "Sandbox", exact: true })
  const notice = page.getByRole("status", { name: "Sandbox minutes" })
  const left = page.getByText(/^\d+ min left$/)
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(notice).toHaveText("5 minutes left", { timeout: 20_000 })
  await expect(left).toHaveText(/^5 min left$/)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(status).toHaveText("Stopped")
  await page.getByRole("button", { name: "Start", exact: true }).click()
  await expect(status).toHaveText("Running")
  await expect(left).toHaveText(/^600 min left$/, { timeout: 20_000 })
  await expect(notice).toHaveCount(0)
  await expect(status).toHaveText("Running")
})
