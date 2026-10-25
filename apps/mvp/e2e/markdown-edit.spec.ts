import type { Locator, Page } from "@playwright/test"
import { expect, type Tab, test } from "./devices"
import { step } from "./fixtures"
import { ownPlace, requires } from "./target"

// Markdown in place (docs/features/repo.md#the-browser, Will 2026-10-20 18:17: "If they have permission to edit it
// should be wysiwyg otherwise readonly"), end to end: real browsers against the real app, ChatApi, the branch's machine,
// Code Storage, Postgres and Electric. A Markdown file's own page is an editable WYSIWYG document for a person who may
// write the branch, typed through the branch's shared text and saved to its working copy (docs/features/coedit.md);
// anyone else reads it. On a deployment the writer's branch is the test account's own; locally it is the public
// `octocat/Spoon-Knife`'s `test-branch`, tracked as the local developer's. Nothing is written to GitHub.

const LOCAL = { owner: "octocat", name: "Spoon-Knife", ref: "test-branch" }
const FILE = "README.md"

/** A branch's machine may take a while to start on a cold host; the shared text waits for its first read. */
const MACHINE = 240_000

/** The repository's page and its files come through RepoApi and Electric. */
const SYNC = 90_000

/** The writer's branch, as its directory page's path: the test account's own on a deployment, else the fixture, tracked. */
const writerBranch = async (tab: Tab) => {
  const own = ownPlace()
  if (own !== undefined) return own.path
  const tracked = await tab.page.request.post("/api/branches", { data: LOCAL })
  expect([200, 201], "the person tracks the fixture branch").toContain(tracked.status())
  return `/${LOCAL.owner}/${LOCAL.name}/tree/${LOCAL.ref}`
}

/** `branch`'s directory page as the page of its README.md. */
const blobOf = (branch: string) => `${branch.replace("/tree/", "/blob/")}/${FILE}`

/** The repository's default branch's README.md page: the same repository, locked to all but a merge. */
const defaultBlobOf = (branch: string, defaultBranch: string) => `${branch.split("/tree/")[0]}/blob/${defaultBranch}/${FILE}`

/** README.md's file view on `page`. */
const fileView = (page: Page) => page.locator(`article[aria-label="${FILE}"]`)

/** The document's editable surface, once the page edits it in place. */
const editable = (file: Locator) => file.locator('[contenteditable="true"]')

/** The read-only document: Milkdown's surface with editing off. */
const readOnly = (file: Locator) => file.locator('[contenteditable="false"]').first()

/** The file toolbar's Save button, by what it says. */
const save = (file: Locator, label: "Save" | "Saved") => file.getByRole("button", { name: label, exact: true })

/** Opens `tab`'s terminal on `branch` and runs `command` in the working copy. */
const inTerminal = async (tab: Tab, branch: string, command: string) => {
  await tab.page.goto(`${branch}?terminal=me`)
  const frame = tab.page.frameLocator('iframe[title="Terminal"]').locator("body")
  const open = tab.page.getByRole("button", { name: "Open terminal" })
  await expect(async () => {
    if ((await open.isVisible()) && (await open.isEnabled())) await open.click()
    await expect(frame).toContainText("/workspace", { timeout: 15_000 })
  }).toPass({ timeout: MACHINE })
  await tab.page.locator('iframe[title="Terminal"]').click()
  await tab.page.keyboard.type(command)
  await tab.page.keyboard.press("Enter")
  return frame
}

test("Markdown in place: a writer edits a Markdown file's page as a document and saves it; the locked default branch reads it", {
  annotation: {
    type: "summary",
    description: "A person who may write the branch types in a Markdown file's own page and saves it to the working copy; on the locked default branch the same file is read-only.",
  },
}, async ({ devices }) => {
  requires("member", "ownConversation", "codeStorage")
  test.setTimeout(10 * 60_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const branch = await writerBranch(a!)
  const file = fileView(a!.page)

  await step(`A opens ${FILE} on a branch A may write: an editable document`, async () => {
    await a!.page.goto(blobOf(branch))
    await expect(a!.page.getByRole("navigation", { name: "Branch" })).toBeVisible({ timeout: SYNC })
    // The read-only document shows at once; the live editor takes its place once the working copy's text is in.
    await expect(editable(file), "the document is editable in place").toBeVisible({ timeout: MACHINE })
    await expect(save(file, "Save").or(save(file, "Saved"))).toBeVisible()
  })

  await step("A types at the document's end and saves; the page says Saved", async () => {
    await editable(file).click()
    await a!.page.keyboard.press("ControlOrMeta+End")
    await a!.page.keyboard.press("Enter")
    await a!.page.keyboard.type(`edited-${word}`)
    await expect(editable(file)).toContainText(`edited-${word}`)
    await expect(save(file, "Save")).toBeVisible({ timeout: SYNC })
    await save(file, "Save").click()
    await expect(save(file, "Saved"), "the Save landed in the working copy").toBeVisible({ timeout: MACHINE })
  })

  await step("A reload keeps the edit, still editable and Saved", async () => {
    await a!.page.reload()
    await expect(editable(file)).toContainText(`edited-${word}`, { timeout: MACHINE })
    await expect(save(file, "Saved")).toBeVisible({ timeout: SYNC })
  })

  await step("The working copy holds the edit; the file goes back to the branch's", async () => {
    // The shell prints has-42 only when the file holds the edit; the echoed command says $((40+2)).
    const terminal = await inTerminal(a!, branch, `grep -q edited-${word} ${FILE} && echo has-$((40+2))-${word}; git checkout -- ${FILE}`)
    await expect(terminal, "the saved file has the edit").toContainText(`has-42-${word}`, { timeout: 30_000 })
  })

  await step(`The default branch's ${FILE} reads as a document no one edits here`, async () => {
    const repository = branch.split("/tree/")[0]!.slice(1)
    const about = await a!.page.request.get(`/api/repos/${repository}/refs`)
    const defaultBranch = about.ok() ? ((await about.json()) as { readonly defaultBranch: string }).defaultBranch : "main"
    await a!.page.goto(defaultBlobOf(branch, defaultBranch))
    await expect(readOnly(file), "the document shows").toBeVisible({ timeout: SYNC })
    await expect(editable(file), "the locked branch's document is read-only").toHaveCount(0)
    await expect(save(file, "Save")).toHaveCount(0)
  })
})

test("Markdown in place: a Guest, who may not write the branch, reads the Markdown file's page", {
  annotation: {
    type: "summary",
    description: "Someone without write permission opens a Markdown file's page on a branch others edit: a read-only document with no Save.",
  },
}, async ({ devices }) => {
  requires("devPeople", "codeStorage")
  test.setTimeout(5 * 60_000)
  const [a] = await devices.open("A")
  const branch = await writerBranch(a!)
  const [guest] = await devices.openAs("guest", "Guest")
  const file = fileView(guest!.page)

  await step(`The Guest opens ${FILE} on the branch: a read-only document`, async () => {
    await guest!.page.goto(blobOf(branch))
    await expect(readOnly(file), "the document shows").toBeVisible({ timeout: SYNC })
    await expect(editable(file), "nothing in it is editable").toHaveCount(0)
    await expect(save(file, "Save")).toHaveCount(0)
    await expect(save(file, "Saved")).toHaveCount(0)
  })
})
