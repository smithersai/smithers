// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// A transport that loses answers and sends the request again with its operation id (test/support/FaultyFactory.vibe,
// fault=sandbox-replay). The sandbox writer (src/core/sandboxHost.vibe `admit`) answers a resent start or command from
// its receipt, so neither runs twice, and refuses a different command sent under a used id.
import { expect, test } from "./coverage"

test("a resent start and command run once, and a command under a used id is refused", async ({ page }) => {
  await page.goto("/e2e/runtime/index.html?agent=mock&fault=sandbox-replay")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
  const status = page.getByRole("status", { name: "Sandbox" })
  await expect(status).toHaveText("Running")
  await expect(page.getByRole("alert")).toHaveCount(0)
  const command = page.getByRole("textbox", { name: "Terminal command" })
  const output = page.getByLabel("Terminal output")
  await command.fill("echo once")
  await command.press("Enter")
  await expect(output).toContainText("once")
  // The resend answered from the receipt: the transcript holds the command once.
  await expect.poll(async () => ((await output.textContent()) ?? "").split("$ echo once").length - 1).toBe(1)
  await command.fill("echo twice")
  await command.press("Enter")
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(output).not.toContainText("twice")
  await command.fill("pwd")
  await command.press("Enter")
  await expect(output).toContainText("/workspace")
  await expect(status).toHaveText("Running")
})
