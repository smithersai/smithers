// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The scripted agent's wiki drafts in the mock's fixture repository (src/core/WikiFactory.vibe, the `draft` op): a
// person's second draft of a page replaces their first.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

const wiki = (page: Page) => page.getByRole("region", { name: "Wiki", exact: true })

async function ask(page: Page, text: string, count: number) {
  const prompt = page.getByRole("textbox", { name: "Message" })
  await prompt.fill(text)
  await prompt.press("Enter")
  const answers = page.locator(".sui-chat-message[data-role='assistant']")
  await expect(answers).toHaveCount(count, { timeout: 15_000 })
  await expect(answers.last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  return answers.last()
}

test("a second agent draft of the same page replaces the first", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await expect(page.locator(".vl-nav-role")).toHaveText("Contributor")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await expect(await ask(page, "Draft a wiki edit for the roadmap: add the first brick", 1)).toContainText("Drafted an edit to Roadmap.")
  await expect(await ask(page, "Draft a wiki edit for the roadmap: add the second brick", 2)).toContainText("Drafted an edit to Roadmap.")
  await page.getByRole("link", { name: "Review it", exact: true }).last().click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Roadmap" })
  await expect(editor).toHaveValue(/add the second brick/)
  await expect(editor).not.toHaveValue(/add the first brick/)
})

