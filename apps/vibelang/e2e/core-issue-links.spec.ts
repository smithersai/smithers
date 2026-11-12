// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// Links through the mock's real issue host (src/core/IssuesFactory.vibe over issueGraphDecision): a link that moves an
// issue under another, with its note, and a link into the issue's own subtree, which the host refuses.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

async function openIssue(page: Page, title: string) {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("link", { name: title, exact: true }).click()
}

async function link(page: Page, issue: number, parent: string) {
  await page.getByRole("button", { name: "Link", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `Link #${issue}` })
  await dialog.getByRole("textbox", { name: "Parent", exact: true }).fill(parent)
  await dialog.getByRole("button", { name: "Link", exact: true }).click()
  return dialog
}

test("a link moves an issue under another and notes it", async ({ page }) => {
  await openIssue(page, "Case branches on tuples")
  await link(page, 42, "45")
  await expect(page.locator(".ix-tree-parent")).toContainText("#45")
  await expect(page.locator(".sui-item-conv-events")).toContainText("linked this under #45")
})

test("a link under the issue's own child is refused and changes nothing", async ({ page }) => {
  await openIssue(page, "Effect-native modules")
  const dialog = await link(page, 38, "42")
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(page.locator(".ix-tree-parent")).toHaveCount(0)
  await expect(dialog).toBeVisible()
})
