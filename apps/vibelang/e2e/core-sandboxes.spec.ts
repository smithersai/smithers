// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The mock sandbox's terminal (src/core/sandboxMock.vibe) answers each kind of command the way the page shows it.
import { expect, test } from "./coverage"

test("the mock terminal answers pwd, ls, a missing file and a command it lacks", async ({ page }) => {
  await page.goto("/?agent=mock&role=contributor")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(page.getByRole("status", { name: "Sandbox" })).toHaveText("Running")
  const command = page.getByRole("textbox", { name: "Terminal command" })
  const output = page.getByLabel("Terminal output")
  const run = async (line: string) => {
    await command.fill(line)
    await command.press("Enter")
    await expect(command).toBeEnabled()
  }
  await run("pwd")
  await expect(output).toContainText("/workspace")
  await run("echo one > one.txt")
  await run("echo two > two.txt")
  await run("ls")
  await expect(output).toContainText("one.txt  two.txt")
  await run("cat missing.txt")
  await expect(output).toContainText("cat: No such file")
  await run("make")
  await expect(output).toContainText("Command unavailable in mock mode")
})
