import { expect, type Tab, test } from "./devices"
import { requires, scratchRepository, scriptedAgent, stackRepository } from "./target"

// TODOs and the stack, end to end (decision 0016 slice 1, Track A; docs/features/todos.md): two people in real
// browsers against the real app, ChatApi, its one stack writer, Postgres and Electric. Ann asks Smithers for a TODO;
// her agent is the scripted one in her browser's engine worker (`/app?agent=todo-draft`, src/test/scriptedAgent.ts),
// so the draft it makes is the same every run; everything else is real. Ben is local development's second person, a
// Member (`smithers_dev_person=teammate`, worker/DevChatApi.ts). Every run commits its own TODO, found by a word
// unique to the run, and drops it, so the shared stack doesn't fill. The stack is drawn as GitHub's issue list (Open and
// Closed tabs, Drop in a row's menu) and one TODO as GitHub's issue page (Drop in its side column).

/** The repository whose stack the tests use: any repository's name has a stack; this one is public. */
const REPO = "octocat/Spoon-Knife"

/** The stack page's row of the TODO whose title has `word`. */
const row = (tab: Tab, word: string) =>
  tab.page.getByRole("region", { name: `${REPO} stack` }).locator("[data-slot=issues-row]", { hasText: word })

/** The page of the TODO titled `title`. */
const todoPage = (tab: Tab, title: string) => tab.page.getByRole("article", { name: new RegExp(title) })

/** Opens the stack page on `tab`. */
const openStack = async (tab: Tab, path = `/${REPO}/stack`) => {
  await tab.page.goto(path)
  await expect(tab.page.getByRole("region", { name: `${REPO} stack` }), `${tab.name}: the stack opens`).toBeVisible({
    timeout: 60_000,
  })
}

test("todo-commit-drop: Ann asks Smithers for a TODO, edits the draft and commits; Ben sees it; Ann drops it", async ({ devices }) => {
  requires("scriptedAgent", "devPeople")
  test.setTimeout(300_000)
  const word = devices.word
  const [ann] = await devices.open("Ann")
  const [ben] = await devices.openTeammate("Ben")
  await ann.page.goto(scriptedAgent("todo-draft"))
  await ann.ready()

  // Ann asks; the agent drafts. The draft card shows under its answer, on her device only.
  const question = `todo-draft ${REPO} ${word}`
  await ann.askAndWaitTaken(question)
  const draft = ann.page.getByRole("form", { name: "TODO draft" })
  await expect(draft, "Ann: the draft card shows under the answer").toBeVisible({ timeout: 120_000 })
  await expect(draft.getByText("Only you")).toBeVisible()
  await expect(draft.getByLabel("Prompt")).toHaveValue(`Add a line to the README: ${word}`)

  // She edits its title and commits it: the stack opens, and the TODO shows T– Requested, then numbered and Queued.
  const title = `README line ${word}`
  await draft.getByLabel("Title").fill(title)
  await draft.getByRole("button", { name: "Commit" }).click()
  await expect(ann.page).toHaveURL(new RegExp(`/${REPO}/stack$`), { timeout: 30_000 })
  await expect(row(ann, word), "Ann: numbered and Queued").toHaveAttribute("data-status", "queued", { timeout: 60_000 })
  await expect(row(ann, word)).toContainText(/T\d+/, { timeout: 60_000 })
  await expect(row(ann, word)).not.toHaveAttribute("data-pending", /.+/, { timeout: 60_000 })
  const number = (await row(ann, word).textContent())!.match(/T(\d+)/)![1]!

  // Ben opens the stack: the same TODO, the same number, and its page: the prompt, the criteria, who committed it.
  await openStack(ben)
  await expect(row(ben, word), "Ben: sees Ann's TODO").toContainText(`T${number}`, { timeout: 60_000 })
  await row(ben, word).getByRole("link", { name: title }).click()
  await expect(ben.page).toHaveURL(new RegExp(`/${REPO}/stack/${number}$`))
  const card = todoPage(ben, title)
  await expect(card).toContainText(`Add a line to the README: ${word}`, { timeout: 60_000 })
  await expect(card).toContainText("The README ends with the line")
  await expect(card).toHaveAttribute("data-status", "queued")
  await expect(card.getByRole("list", { name: "Timeline" })).toContainText("committed")

  // Both reload: each device shows it from its own store and the stack.
  await ann.page.reload()
  await ben.page.reload()
  await expect(row(ann, word)).toContainText(`T${number}`, { timeout: 60_000 })
  await expect(todoPage(ben, title)).toContainText(`T${number}`, { timeout: 60_000 })

  // Ann opens it and drops it from its page, confirming once: Dropped on both devices.
  await row(ann, word).getByRole("link", { name: title }).click()
  await todoPage(ann, title).getByRole("button", { name: "Drop", exact: true }).click()
  const confirm = ann.page.getByRole("dialog", { name: `Drop T${number}?` })
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused()
  await confirm.getByRole("button", { name: "Drop", exact: true }).click()
  for (const tab of [ann, ben]) {
    await expect(todoPage(tab, title), `${tab.name}: Dropped`).toHaveAttribute("data-status", "dropped", { timeout: 60_000 })
  }
  await expect(todoPage(ben, title).getByRole("button", { name: "Drop", exact: true })).toHaveCount(0)

  // Back on the stack it has left the Open list, and the Closed list shows it Dropped.
  await ann.page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Stack" }).click()
  await expect(ann.page.getByRole("region", { name: `${REPO} stack` })).toBeVisible()
  await expect(row(ann, word)).toHaveCount(0)
  await ann.page.getByRole("navigation", { name: "Filter" }).getByRole("link", { name: /Closed/ }).click()
  await expect(ann.page).toHaveURL(new RegExp(`/${REPO}/stack\\?state=closed$`))
  await expect(row(ann, word)).toHaveAttribute("data-status", "dropped", { timeout: 60_000 })
})

test("todo-new-keyboard: New TODO on the stack page, typed and committed with the keyboard, then dropped", async ({ devices }) => {
  requires("member", "writableStack")
  const repo = stackRepository()
  const keyboardRow = (tab: Tab, word: string) => tab.page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: word })
  test.setTimeout(240_000)
  const word = devices.word
  const [ann] = await devices.open("Ann")
  await ann.page.goto(`/${repo}/stack`)
  await expect(ann.page.getByRole("region", { name: `${repo} stack` })).toBeVisible({ timeout: 60_000 })
  await ann.page.getByRole("button", { name: "New TODO" }).focus()
  await ann.page.keyboard.press("Enter")
  const draft = ann.page.getByRole("form", { name: "TODO draft" }).first()
  await draft.getByLabel("Title").focus()
  await ann.page.keyboard.type(`Keyboard ${word}`)
  await ann.page.keyboard.press("Tab")
  await ann.page.keyboard.type("Typed without a mouse.")
  await ann.page.keyboard.press("ControlOrMeta+Enter")
  await expect(keyboardRow(ann, word)).toContainText(/T\d+/, { timeout: 60_000 })
  await expect(keyboardRow(ann, word)).not.toHaveAttribute("data-pending", /.+/, { timeout: 60_000 })
  const number = (await keyboardRow(ann, word).textContent())!.match(/T(\d+)/)![1]!

  // Drop with the keyboard, from the row's menu: Enter opens it on Drop, Enter asks with the focus on Cancel, the safe
  // choice; Tab reaches Drop, and Enter drops it. The row leaves the Open list for the Closed one.
  await keyboardRow(ann, word).getByRole("button", { name: `T${number} actions` }).focus()
  await ann.page.keyboard.press("Enter")
  await expect(ann.page.getByRole("menuitem", { name: "Drop" })).toBeFocused()
  await ann.page.keyboard.press("Enter")
  const confirm = ann.page.getByRole("dialog", { name: `Drop T${number}?` })
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused()
  await ann.page.keyboard.press("Tab")
  await expect(confirm.getByRole("button", { name: "Drop", exact: true })).toBeFocused()
  await ann.page.keyboard.press("Enter")
  await expect(keyboardRow(ann, word)).toHaveCount(0, { timeout: 60_000 })
  await ann.page.getByRole("navigation", { name: "Filter" }).getByRole("link", { name: /Closed/ }).focus()
  await ann.page.keyboard.press("Enter")
  await expect(keyboardRow(ann, word)).toHaveAttribute("data-status", "dropped", { timeout: 60_000 })
})

// Make TODO on an issue (docs/features/todos.md#from-an-issue) needs an open issue GitHub's projection holds, as
// e2e/issues.spec.ts does: a deployment signed in as the test account, a Member or above on E2E_ISSUES_REPOSITORY, the
// scratch repository with the Smithers GitHub App installed (`requires("syncedScratch")`, e2e/target.ts).

test("todo-from-issue: Make TODO from an issue's menu drafts it linked; the issue shows its TODO; t makes a second while the first is open", async ({ devices }) => {
  requires("syncedScratch", "member")
  test.setTimeout(300_000)
  const repo = scratchRepository()
  const [ann] = await devices.open("Ann")
  const page = ann.page

  // From the issues list: Make TODO in an open issue's menu opens the stack with a draft from it.
  await page.goto(`/${repo}/issues`)
  const issues = page.getByRole("region", { name: `${repo} issues` })
  const issueRow = issues.locator("[data-slot=issues-row][data-state=open]")
    .filter({ has: page.getByRole("button", { name: /^#\d+ actions$/ }) })
    .first()
  await expect(issueRow, "Ann: an open issue to make a TODO from").toBeVisible({ timeout: 120_000 })
  const number = (await issueRow.locator(".sui-issues-number").textContent())!.slice(1)
  const title = (await issueRow.locator(".sui-issues-title").textContent())!
  await issueRow.getByRole("button", { name: `#${number} actions` }).click()
  await page.getByRole("menuitem", { name: "Make TODO" }).click()
  await expect(page).toHaveURL(new RegExp(`/${repo}/stack$`))
  const draft = page.getByRole("form", { name: "TODO draft" }).filter({ hasText: `#${number}` })
  await expect(draft.getByLabel("Title"), "Ann: the draft takes the issue's title").toHaveValue(title.slice(0, 120).trim(), { timeout: 30_000 })
  await draft.getByRole("button", { name: "Commit" }).click()
  const todoRow = page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: title.slice(0, 40) })
  await expect(todoRow.getByRole("link", { name: `#${number}` }), "Ann: the TODO shows its issue").toBeVisible({ timeout: 60_000 })
  await expect(todoRow).toContainText(/T\d+/, { timeout: 60_000 })
  const todo = (await todoRow.locator(".sui-issues-number").textContent())!

  // The issue shows its TODO, and Make TODO stays while that TODO is open: one issue can become a stack of TODOs.
  await todoRow.getByRole("link", { name: `#${number}` }).click()
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues/${number}$`))
  const side = page.getByRole("region", { name: "TODO" })
  await expect(side.getByRole("link", { name: todo })).toBeVisible({ timeout: 60_000 })
  await expect(side.getByRole("button", { name: /Make TODO/ })).toBeVisible()

  // Its key t makes a second draft from the same issue; discarded, it leaves the first TODO as it was.
  await page.keyboard.press("t")
  await expect(page).toHaveURL(new RegExp(`/${repo}/stack$`))
  const again = page.getByRole("form", { name: "TODO draft" }).filter({ hasText: `#${number}` })
  await expect(again).toBeVisible({ timeout: 30_000 })
  await again.getByRole("button", { name: "Discard" }).click()
  await expect(again).toHaveCount(0)

  // Dropped, the issue still lists its TODO and still offers Make TODO.
  await page.goto(`/${repo}/issues/${number}`)
  await side.getByRole("link", { name: todo }).click()
  await page.getByRole("button", { name: "Drop", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Drop", exact: true }).click()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues/${number}$`))
  await expect(side.getByRole("link", { name: todo })).toBeVisible({ timeout: 60_000 })
  await expect(side.getByRole("button", { name: /Make TODO/ })).toBeVisible({ timeout: 60_000 })
})
