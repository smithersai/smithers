// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// fault=sandbox-last-minute moves the meter's clock, once the sandbox starts, to 30 seconds before the allowance runs
// out (test/support/FaultyFactory.vibe). The next read meters those seconds; the next meter is due when they end,
// sooner than the minute's interval (sandboxDecision.vibe `meterDelay`), and the notice counts one minute.
import { expect, test } from "./coverage"

test("a sandbox started in its last minute says one minute is left", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?agent=mock&fault=sandbox-last-minute")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(page.getByRole("status", { name: "Sandbox minutes" })).toHaveText("1 minute left", { timeout: 20_000 })
  await expect(page.getByRole("status", { name: "Sandbox", exact: true })).toHaveText("Running")
})
