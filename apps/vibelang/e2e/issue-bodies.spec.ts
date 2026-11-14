// Stays .ts: Playwright collects test files by JS/TS extension only.
// An issue's body as a person typed it (src/web/issuesView.vibe `issueBody`, markdown.vibe `blocks`): a code fence the
// person never closed still shows the code as code, through the end of the text.
import { expect, test } from "./coverage"

test("a summary whose code fence is never closed shows the rest as code", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("button", { name: "New issue", exact: true }).click()
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Unclosed fence")
  await page.getByRole("textbox", { name: "Summary", exact: true }).fill("This fails:\n```vibe\nconst pair = [0, 1]\nmatch (pair) {")
  await page.locator(".sui-issue-form-actions").getByRole("button", { name: "New issue", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Unclosed fence" })).toBeVisible()
  const code = page.locator("pre.vl-code code").filter({ hasText: "const pair" })
  await expect(code).toHaveText("const pair = [0, 1]\nmatch (pair) {")
  await expect(page.getByText("This fails:", { exact: true })).toBeVisible()
})
