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

// fault=machine-stop-clock: the same clock, and the machine fails the first stop. The writer keeps that stop pending and
// finishes it on its next alarm, once the clock reads again (sandboxHost.vibe `emergency`, then `current`'s recovery).
test("a stop the broken clock asks for that the machine fails finishes on the next alarm", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?agent=mock&fault=machine-stop-clock")
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

// fault=sandbox-clock-read: the clock is broken for the pane's first read, before the writer has saved anything
// (sandboxHost.vibe `load`): that read fails with nothing to stop, the pane's next read clears its alert, and a start
// runs on the mended clock.
test("a clock the meter cannot read on the first look leaves nothing stuck, and a start then runs", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?agent=mock&fault=sandbox-clock-read")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(page.getByRole("status", { name: "Sandbox" })).toHaveText("Running")
  await expect(page.getByRole("alert")).toHaveCount(0)
  const command = page.getByRole("textbox", { name: "Terminal command" })
  await command.fill("pwd")
  await command.press("Enter")
  await expect(page.getByLabel("Terminal output")).toContainText("/workspace")
})
