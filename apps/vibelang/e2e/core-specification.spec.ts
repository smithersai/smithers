// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// Specification reviews through the mock's real issue host (src/core/specification.vibe): a maintainer requests one
// reviewer's review, and the scripted agent requests one when a chat names a reviewer.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

async function maintainer(page: Page) {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
}

test("a maintainer requests one reviewer's review and History records it", async ({ page }) => {
  await maintainer(page)
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("button", { name: "Specification", exact: true }).click()
  const table = page.getByRole("table", { name: "Specification reviews" })
  await expect(table.getByRole("row")).toHaveCount(5)
  await page.getByLabel("Issues pane").getByText("History", { exact: true }).click()
  const events = page.locator(".sui-item-conv-event")
  const before = await events.count()
  await table.getByRole("row", { name: /Codex Sol/ }).getByRole("button", { name: "Request review" }).click()
  await expect(events).toHaveCount(before + 1)
  await expect(events.last()).toContainText("Codex Sol · LGTM")
})

test("the agent requests a review when a chat names the reviewer, and not otherwise", async ({ page }) => {
  await maintainer(page)
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  const dialog = page.getByRole("dialog")
  const answers = page.locator(".sui-chat-message[data-role='assistant']")
  await dialog.getByRole("textbox", { name: "Message" }).fill("Review the specification with Claude Fable")
  await dialog.getByRole("button", { name: "Send", exact: true }).click()
  await expect(answers.last()).toHaveAttribute("data-done", "true")
  await expect(answers.last()).toContainText("Claude Fable · LGTM")
  // The conversation now docks in the page; its composer answers the next message.
  const prompt = page.getByRole("textbox", { name: "Message" })
  await prompt.fill("Review the specification")
  await prompt.press("Enter")
  await expect(answers).toHaveCount(2)
  await expect(answers.last()).toHaveAttribute("data-done", "true")
  await expect(answers.last()).not.toContainText(" · LGTM")
})
