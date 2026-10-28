import { expect, test } from "./devices"
import { requires, scratchRepository } from "./target"

// Create issue's progress in the shared toast stack (decision 0124): Requested at the press, the server's Working,
// then Done on its issue once GitHub has it, through navigation and a reload.

test("Create issue: progress follows its write across a reload until GitHub has the issue", {
  annotation: { type: "summary", description: "One toast from the press to the created issue" },
}, async ({ devices }) => {
  requires("member", "syncedScratch")
  test.setTimeout(180_000)
  const repo = scratchRepository()
  const [person] = await devices.open("Maya")
  const page = person!.page
  const title = `progress-issue-${devices.word}`
  await page.goto(`/${repo}/issues/new`)
  await page.getByLabel("Title", { exact: true }).fill(title)
  await page.getByLabel("Description", { exact: true }).fill("Progress through completion")
  await page.getByRole("button", { name: "Create issue", exact: true }).click()
  const toast = page.locator('[data-slot="toast"]').filter({ hasText: "Create issue" })
  await expect(toast).toContainText(/Requested|Working|Done/)
  const subject = await toast.getAttribute("data-subject")
  await page.reload()
  const same = page.locator(`[data-slot="toast"][data-subject="${subject}"]`)
  await expect(page).toHaveURL(/\/issues\/\d+$/, { timeout: 120_000 })
  await expect(page.getByRole("heading").filter({ hasText: title })).toBeVisible()
  await expect(same).toContainText("Done")
  await expect(same).not.toContainText("Failed")
})
