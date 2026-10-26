import { messageIn, questionIn } from "./messages"
import type { Page } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { ownPlace, requires, scriptedAgent } from "./target"

// File tabs end to end (docs/features/files.md), against the real app, Worker, Postgres, Electric, GitHub and Code
// Storage: the agent opens a file of the branch the person's workspace shows as a tab, its lines highlighted, through
// `file/open`; and a person moves between tabs and closes them with the keyboard, through the same flows. The agent is
// the scripted one in the asking browser's engine worker (`?agent=show-code`, src/test/scriptedAgent.ts), so it calls
// the flow the same way every time; the eval case `files-show-lines` holds the real model to it. The fixture is the
// public `octocat/Spoon-Knife`, cloned once. Opening a branch's page tracks it and asking needs a Member or above.

requires("personalModel", "member", "ownConversation")

const REPO = "/octocat/Spoon-Knife"

const fileProofHome = () => ownPlace()?.path ?? `${REPO}/tree/main`

/** Opens Spoon-Knife, cloning it if no run has yet, and waits until its code is on the device. */
const openReady = (page: Page) =>
  step("Open Spoon-Knife", async () => {
    await page.goto(REPO)
    const header = page.locator('header[aria-label="Repository"]')
    await expect(header).toContainText("octocat / Spoon-Knife", { timeout: 30_000 })
    const picker = page.getByRole("button", { name: "main", exact: true })
    const clone = header.getByRole("button", { name: "Clone" })
    await expect(picker.or(clone)).toBeVisible({ timeout: 60_000 })
    if (await clone.isVisible()) await clone.click()
    await expect(picker).toBeVisible({ timeout: 120_000 })
  })

/** Types `text` into the composer and sends it, opening the composer first when it is closed. */
const send = async (page: Page, text: string) => {
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  if (!(await composer.isVisible())) await page.getByRole("button", { name: /Chat/ }).click()
  await composer.fill(text)
  await composer.press("Enter")
}

const strip = (page: Page) => page.getByRole("tablist", { name: "Open files" })

/** The code view's line `line`, highlighted or not: the code renders in an open shadow root, which locators pierce. */
const line = (page: Page, n: number, selected: boolean) =>
  page.locator(`[data-line="${n}"]${selected ? "[data-selected-line]" : ":not([data-selected-line])"}`).first()

test(
  "agent shows code: asked to show lines of a file, the agent opens it as a tab with the lines highlighted",
  { annotation: { type: "summary", description: "The agent opens index.html at lines 3 to 5 as a tab beside README.md, the lines highlighted." } },
  async ({ page }) => {
    requires("codeStorage", "scriptedAgent")
    await openReady(page)
    await step("Open README.md", async () => {
      await page.goto(`${REPO}/blob/main/README.md`)
      await expect(strip(page).getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })
    })
    await step("Open the branch's workspace", async () => {
      await page.goto(scriptedAgent("show-code", `${REPO}/tree/main`))
      await expect(page.getByRole("navigation", { name: "Branch" })).toContainText("main", { timeout: 30_000 })
      // The strip shows on the branch's directory pages too, no file on screen.
      await expect(strip(page).getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "false")
    })
    await step("Ask Smithers to show index.html at lines 3 to 5", async () => {
      await send(page, "show-code index.html 3-5")
    })
    await step("The file opens as a tab, lines 3 to 5 highlighted", async () => {
      await expect(page).toHaveURL(/\/octocat\/Spoon-Knife\/blob\/main\/index\.html\?L=3-5$/, { timeout: 60_000 })
      await expect(strip(page).getByRole("tab")).toHaveText(["README.md", "index.html"])
      await expect(strip(page).getByRole("tab", { name: "index.html" })).toHaveAttribute("aria-selected", "true")
      for (const n of [3, 4, 5]) await expect(line(page, n, true)).toBeVisible({ timeout: 30_000 })
      for (const n of [2, 6]) await expect(line(page, n, false)).toBeVisible()
    })
    await step("The conversation stays beside the file, with the agent's answer", async () => {
      const conversation = page.getByRole("region", { name: "Conversation", exact: true })
      await expect(questionIn(conversation, "show-code index.html 3-5")).toBeVisible()
      await expect(messageIn(conversation, "Opened index.html at lines 3-5.")).toBeVisible({ timeout: 60_000 })
    })
  },
)

test(
  "keyboard: arrows move between file tabs, Enter opens one, Delete closes the one on screen",
  { annotation: { type: "summary", description: "Arrows and Enter switch file tabs; Delete closes the file on screen and the tab beside it shows, at its lines." } },
  async ({ page }) => {
    requires("codeStorage")
    await openReady(page)
    await step("Open two files, the second at lines 2 to 4", async () => {
      await page.goto(`${REPO}/blob/main/README.md`)
      await expect(strip(page).getByRole("tab")).toHaveText(["README.md"], { timeout: 30_000 })
      await page.goto(`${REPO}/blob/main/index.html?L=2-4`)
      await expect(strip(page).getByRole("tab")).toHaveText(["README.md", "index.html"], { timeout: 30_000 })
    })
    const readme = strip(page).getByRole("tab", { name: "README.md" })
    const index = strip(page).getByRole("tab", { name: "index.html" })
    await step("← moves to README.md, Enter opens it", async () => {
      await index.focus()
      await page.keyboard.press("ArrowLeft")
      await expect(readme).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(page).toHaveURL(/\/blob\/main\/README\.md$/)
      await expect(readme).toHaveAttribute("aria-selected", "true")
    })
    await step("Delete closes README.md; index.html shows, at its lines", async () => {
      await readme.focus()
      await page.keyboard.press("Delete")
      await expect(page).toHaveURL(/\/blob\/main\/index\.html\?L=2-4$/)
      await expect(strip(page).getByRole("tab")).toHaveText(["index.html"])
      await expect(index).toBeFocused()
      await expect(line(page, 3, true)).toBeVisible({ timeout: 30_000 })
    })
    await step("A reload keeps the tab", async () => {
      await page.reload()
      await expect(strip(page).getByRole("tab")).toHaveText(["index.html"], { timeout: 30_000 })
    })
  },
)

test(
  "workspace: a file's page is its branch's workspace, the conversation beside it, as a directory's is",
  { annotation: { type: "summary", description: "Moving between a branch's directory, its file and its terminal keeps the branch's workspace and conversation." } },
  async ({ page }) => {
    const conversation = page.getByRole("region", { name: "Conversation", exact: true })
    const branch = page.getByRole("navigation", { name: "Branch" })
    /** Moves this tab through the router, as a link does: `/navigate`, the person's door to `app/navigate`. */
    const go = (path: string) => send(page, `/navigate ${path}`)
    await step("Open a directory of test-branch: its workspace", async () => {
      await page.goto(`${REPO}/tree/test-branch`)
      await expect(branch).toContainText("test-branch", { timeout: 30_000 })
      await expect(conversation).toBeVisible()
    })
    await step("Go to a file of it: the same workspace, Code the file", async () => {
      await go(`${REPO}/blob/test-branch/README.md`)
      await expect(page).toHaveURL(/\/blob\/test-branch\/README\.md$/, { timeout: 30_000 })
      await expect(branch).toContainText("test-branch")
      await expect(conversation).toBeVisible()
      await expect(branch.getByRole("link", { name: "Code" })).toHaveAttribute("href", `${REPO}/blob/test-branch/README.md`)
      await expect(branch.getByRole("link", { name: "Terminal" })).toHaveAttribute("href", `${REPO}/tree/test-branch?terminal=me`)
    })
    await step("Terminal from the file: still the workspace", async () => {
      await branch.getByRole("link", { name: "Terminal" }).click()
      await expect(page).toHaveURL(/\/tree\/test-branch\?terminal=me$/)
      await expect(conversation).toBeVisible()
    })
    await step("Leave for the home conversation: the workspace goes", async () => {
      await go("/app")
      await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 })
      await expect(branch).toHaveCount(0)
    })
  },
)

test("live agent shows code: own-branch file tab highlights the requested lines", {
  annotation: { type: "summary", description: "The real agent opens README.md on the test account's branch with only lines 1 to 2 highlighted." },
}, async ({ page }) => {
  requires("liveModel", "codeStorage")
  test.setTimeout(240_000)
  if (ownPlace() === undefined) await openReady(page)
  await page.goto(fileProofHome())
  const start = new URL(page.url())
  const branchPath = start.pathname
  await step("Ask the agent to show README.md", async () => {
    await send(page, "Show README.md in this branch as a file tab using file/open, and highlight lines 1 to 2. Keep the conversation beside the file.")
  })
  await step("The branch's file opens with the requested highlight", async () => {
    await expect(strip(page).getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 180_000 })
    await expect(page).toHaveURL(/\/blob\/[^/]+\/README\.md\?L=1-2$/)
    // The agent must stay in the branch that owns this conversation.
    expect(new URL(page.url()).pathname).toBe(branchPath.replace("/tree/", "/blob/") + "/README.md")
    // Markdown starts in Preview; its Code control exposes the source line markers.
    await page.getByRole("group", { name: "Show as" }).getByRole("button", { name: "Code", exact: true }).click()
    for (const n of [1, 2]) await expect(line(page, n, true)).toBeVisible({ timeout: 30_000 })
    await expect(line(page, 3, false)).toBeVisible()
    await expect(page.getByRole("region", { name: "Conversation", exact: true })).toBeVisible()
  })
})
