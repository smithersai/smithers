// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The sandbox writer fails closed on a clock it cannot meter by (src/core/sandboxHost.vibe `emergency`): with
// fault=sandbox-clock the clock reads before 1970 for the sandbox's first command ("pwd")
// (test/support/FaultyFactory.vibe). That call fails, the writer stops every running sandbox, and the clock mends.
import { expect, test } from "./coverage"

test("a clock the meter cannot read stops the running sandbox", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?agent=mock&fault=sandbox-clock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
  const status = page.getByRole("status", { name: "Sandbox" })
  await expect(status).toHaveText("Running")
  const command = page.getByRole("textbox", { name: "Terminal command" })
  await command.fill("pwd")
  await command.press("Enter")
  await expect(status).toHaveText("Stopped", { timeout: 20_000 })
  await expect(page.getByLabel("Terminal output")).not.toContainText("/workspace")
})
