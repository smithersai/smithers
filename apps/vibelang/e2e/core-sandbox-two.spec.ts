// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// Two sandboxes in one person's allowance: the home conversation's, then the tour conversation's. Learn more moves the
// page to the tab's tour conversation and it stays there after the tour (src/web/main.vibe `learnMore`), so the
// Sandboxes pane then shows that conversation's sandbox. Each runs on its own machine; both draw on one allowance
// (src/core/sandboxDecision.vibe: the ledger's entries, distinct ids and conversations, the shared meter).
import { expect, test } from "./coverage"

test("a person's sandbox at home and another in the tour conversation run on separate machines", async ({ page }, info) => {
  // A reply, a tour's start and two sandboxes: past the default 30 seconds on a loaded box.
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    localStorage.setItem("vibelang:toured", "yes")
    localStorage.setItem("vibelang:tour-sound", "off")
  })
  await page.goto("/?agent=mock&role=contributor")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  const status = page.getByRole("status", { name: "Sandbox" })
  const command = page.getByRole("textbox", { name: "Terminal command" })
  const output = page.getByLabel("Terminal output")
  const run = async (line: string) => {
    await command.fill(line)
    await command.press("Enter")
    await expect(command).toBeEnabled()
  }
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
  await expect(status).toHaveText("Running")
  await run("echo home > where.txt")

  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  await expect(page.getByRole("region", { name: "Walkthrough" })).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  await page.keyboard.press("Escape")
  await expect(page.getByRole("region", { name: "Walkthrough" })).toHaveCount(0)

  // The tour conversation has no sandbox yet; the home one keeps running on its own machine.
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await expect(status).toHaveText("Stopped")
  await page.getByRole("button", { name: /^(New sandbox|Start)$/ }).first().click()
  await expect(status).toHaveText("Running")
  await run("cat where.txt")
  await expect(output).toContainText("cat: No such file")
  await run("echo tour > where.txt")
  await run("cat where.txt")
  await expect(output).toContainText("tour")
  await expect(output).not.toContainText("home")
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(status).toHaveText("Stopped")
  await page.screenshot({ path: info.outputPath("two-sandboxes.png"), fullPage: true })
})
