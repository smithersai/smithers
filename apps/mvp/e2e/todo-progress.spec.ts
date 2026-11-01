import { expect, test } from "./devices"
import { github } from "./github"
import { hideModelNotice } from "./modelNotice"
import { dropTodo } from "./stackWrites"
import { requires, scratchRepository, stackRepository } from "./target"

// Make TODO's and Commit's progress in the shared toast stack (decision 0124): Make TODO is the engine's run that keeps
// the draft; Commit is Requested until the stack numbers its TODO, then Done, wherever the person went meanwhile.

test("Make TODO: progress lasts until the draft is kept", {
  annotation: { type: "summary", description: "Requested, then Done once the draft shows" },
}, async ({ devices }) => {
  requires("member", "syncedScratch")
  const repo = scratchRepository()
  const [person] = await devices.open("Maya")
  const page = person!.page
  const issues = await github<Array<{ number: number; pull_request?: unknown }>>(page, `/repos/${repo}/issues?state=open&per_page=100`)
  const issue = issues.find((row) => row.pull_request === undefined)
  expect(issue).toBeDefined()
  await page.goto(`/${repo}/issues/${issue!.number}`)
  await page.getByRole("button", { name: "Make TODO", exact: true }).click()
  const toast = page.locator('[data-slot="toast"]').filter({ hasText: "Make TODO" })
  await expect(toast).toBeVisible()
  await expect(page.getByRole("form", { name: "TODO draft" }).first()).toBeVisible()
  await expect(toast).toContainText("Done")
})

test("Commit: progress survives navigation and settles on the numbered TODO", {
  annotation: { type: "summary", description: "One toast from Commit to its TODO, opened from the toast" },
}, async ({ devices }) => {
  requires("member", "writableStack")
  const repo = stackRepository()
  const [person] = await devices.open("Maya")
  const page = person!.page
  const title = `progress-todo-${devices.word}`
  await hideModelNotice(page)
  try {
    await page.goto(`/${repo}/stack`)
    await page.getByRole("button", { name: "New TODO", exact: true }).click()
    const draft = page.getByRole("form", { name: "TODO draft" })
    await draft.getByLabel("Title", { exact: true }).fill(title)
    await draft.getByLabel("Prompt", { exact: true }).fill("Shared progress regression")
    await draft.getByRole("button", { name: "Commit", exact: true }).click()
    const toast = page.locator('[data-slot="toast"]').filter({ hasText: "Commit TODO" })
    await expect(toast).toBeVisible()
    // Away from the stack, through its repository's Issues tab: the stack page's header has no Home link.
    await page.getByRole("link", { name: "Issues", exact: true }).first().click()
    await expect(page).toHaveURL(new RegExp(`/${repo}/issues$`))
    await expect(toast).toContainText("Done", { timeout: 60_000 })
    await expect(toast).not.toContainText("Failed")
    await toast.click()
    await expect(page).toHaveURL(/\/stack\/\d+$/)
    await expect(page.getByRole("heading").filter({ hasText: title })).toBeVisible()
  } finally {
    // The TODO leaves the shared stack, where an open one holds every later TODO of a stacked repository.
    const number = /\/stack\/(\d+)$/.exec(page.url())?.[1]
    if (number !== undefined) await dropTodo(page, repo, Number(number))
  }
})
