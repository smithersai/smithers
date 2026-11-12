// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// What the scripted agent (src/core/MockFactory.vibe) does with a request, by the asker's role: a contributor's sandbox
// starts; a new person's sandbox, specification review and wiki draft are each refused in words; a signed-out
// visitor's issue and split requests file nothing.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

async function ask(page: Page, text: string, count: number) {
  const prompt = page.getByRole("textbox", { name: "Message" })
  await prompt.fill(text)
  await prompt.press("Enter")
  const answers = page.locator(".sui-chat-message[data-role='assistant']")
  await expect(answers).toHaveCount(count, { timeout: 15_000 })
  await expect(answers.last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  return answers.last()
}

test("the agent starts a contributor's sandbox when asked", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await expect(await ask(page, "Start a sandbox", 1)).toContainText(/Started \S+\./)
})

test("a new person's sandbox, review and draft requests are refused in words", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("new")
  await expect(page.locator(".vl-nav-role")).toHaveText("New")
  // A new fixture person's login is joss and an id.
  await expect(page.getByRole("button", { name: "Account", exact: true })).toHaveText("J")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await expect(await ask(page, "Start a sandbox", 1)).toContainText("Couldn't start a sandbox")
  await expect(await ask(page, "Review the specification with Codex Sol", 2)).toContainText("Only contributors can request a specification review.")
  await expect(await ask(page, "Draft a wiki edit for the roadmap: add the wiki-edit brick", 3)).toContainText("Only contributors can draft wiki edits.")
})

test("a visitor's issue and split requests file nothing, and say so", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await expect(await ask(page, "File an issue: Preserve named tuple labels", 1)).toContainText("No issue filed.")
  await expect(await ask(page, "Split #38 into three children, linked under it.", 2)).toContainText("Filed 0 children.")
})
