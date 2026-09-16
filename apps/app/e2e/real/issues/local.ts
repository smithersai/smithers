import type { Locator, Page, TestInfo } from "@playwright/test"
import { closeComposer, expect, openApp } from "../support/test"

export const PRACTICE_REPO = "practice:smithersai/hello-server"

export const attachJson = async (testInfo: TestInfo, name: string, value: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

export const bootPracticeIssues = async (page: Page, state: "open" | "closed" | "all" = "open"): Promise<Locator> => {
  await openApp(page)
  await runSlash(page, `/issues.list ${state} ${PRACTICE_REPO}`)
  const card = page.getByTestId("card-practice-issues")
  await expect(card).toHaveAttribute("data-kind", "issue-list")
  await expect(card.locator('[data-issue="3"]')).toContainText('GET /hello without a name replies "Hello, null!"')
  return card
}

export const openPracticeIssue = async (page: Page, number = 3): Promise<Locator> => {
  const list = await bootPracticeIssues(page, "all")
  const row = list.locator(`[data-issue="${number}"] button[data-flow="issues.view"]`)
  await row.focus()
  await expect(row).toBeFocused()
  await row.press("Enter")
  const card = page.getByTestId("card-practice-issues")
  await expect(card).toHaveAttribute("data-kind", "issue")
  await expect(card.locator(`article[data-issue="${number}"]`)).toBeVisible()
  return card
}

export const practiceIssueCommentCount = async (card: Locator, number = 3): Promise<number> => {
  const text = await card.locator(`article[data-issue="${number}"]`).textContent()
  const count = /\b(\d+)\s+comments?/u.exec(text ?? "")?.[1]
  if (count === undefined) throw new Error(`Issue #${number} did not render its comment count: ${JSON.stringify(text)}`)
  return Number(count)
}

export const runSlash = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!(await input.isVisible())) {
    const chat = page.getByRole("button", { name: "Chat", exact: true })
    await expect(chat).toBeVisible()
    await chat.click()
    await expect(input).toBeVisible()
  }
  await input.click()
  await expect(input).toBeFocused()
  await input.fill(text)
  await input.press("Enter")
  await closeComposer(page)
}
