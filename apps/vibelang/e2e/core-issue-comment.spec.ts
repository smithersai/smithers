// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// Comment with an empty or blank box sends nothing (src/web/issueDecision.vibe `issueAction`). Before, the request
// reached the host, which refused it as empty, and the page showed "Couldn't save. Retry." with a Retry that could
// never succeed.
import { expect, test } from "./coverage"

test("Comment with an empty or blank box sends nothing and shows no error", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
  const box = page.getByRole("textbox", { name: "Comment", exact: true })
  const send = page.locator(".sui-item-conv-composer-actions").getByRole("button", { name: "Comment", exact: true })
  const count = page.locator(".sui-item-conv").getByText(/ · \d+ comments$/)
  await expect(count).toHaveText(/ · 6 comments$/)
  for (const text of ["", "   "]) {
    await box.fill(text)
    await send.click()
    await expect(box).toBeEnabled()
    await expect(page.locator(".sui-issue-form-error")).toHaveCount(0)
    await expect(count).toHaveText(/ · 6 comments$/)
  }
  // The next real comment still sends, so the clicks above changed nothing.
  await box.fill("Sent after the blank ones.")
  await send.click()
  await expect(page.locator(".sui-item-conv-comments")).toContainText("Sent after the blank ones.")
  await expect(count).toHaveText(/ · 7 comments$/)
  await expect(page.locator(".sui-issue-form-error")).toHaveCount(0)
})
