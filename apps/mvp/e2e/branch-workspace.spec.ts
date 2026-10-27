import { questionIn } from "./messages"
import type { Page } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { openComposer } from "./composer"
import { me, requires } from "./target"

// The branch workspace's first slice (decision 0013 §9, docs/features/branch-workspace.md), end to end against the
// real app, Worker, Durable Objects, Postgres, Electric and a real container: open a public repository's existing
// branch, ask in that branch's conversation, open its terminal (our xterm in an opaque-origin frame) and run `git log`
// in the branch's machine, which cloned the branch through the forge proxy; a reload keeps the same shell; another
// branch has its own conversation and its own terminal. The fixture is the public `octocat/Spoon-Knife`, whose
// `test-branch` and `change-the-title` branches GitHub already has; nothing is written to GitHub. Opening a branch's
// page tracks it, which only a Member or above may (worker/branch/Branches.ts), and asking needs one too.

requires("personalModel", "member", "ownConversation")

const REPO = "/octocat/Spoon-Knife"

/** A container's first start builds nothing but may take a while on a cold machine. */
const MACHINE = 200_000

const conversationOf = (page: Page) => page.getByRole("region", { name: "Conversation", exact: true })
/** What the terminal frame shows: xterm's rows, read through the frame (an opaque origin to the page, not to the test). */
const terminalRows = (page: Page) => page.frameLocator('iframe[title="Terminal"]').locator("body")

/** Opens a branch's page and waits for its workspace: the branch's name in its chrome. */
const openBranch = (page: Page, branch: string, search = "") =>
  step(search === "" ? `Open branch ${branch}` : `Open the terminal on ${branch}`, async () => {
    await page.goto(`${REPO}/tree/${branch}${search}`)
    await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(branch, { timeout: 30_000 })
  })

/**
 * The workspace says what it is and leaves nothing blank (Will, 2026-10-20, on these recordings: "I don't even know
 * what I'm looking at here and most of the recording looks like an empty screen"): the chrome names the branch, what
 * this person may do on it and who is there, this person included; the Code view shows the files or Not cloned, never
 * nothing; and the conversation is a column beside the view, not a strip under it.
 */
const expectWorkspace = (page: Page, branch: string) =>
  step(`See branch ${branch}'s workspace`, async () => {
    const chrome = page.getByRole("navigation", { name: "Branch" })
    await expect(chrome).toContainText(branch)
    await expect(chrome).toContainText(/Owner|Can edit/)
    await expect(chrome.getByRole("list", { name: "People here" }).getByRole("button", { name: me().login })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator(".repo-page").or(page.getByText("Clone to browse files", { exact: true }))).toBeVisible({ timeout: 30_000 })
    const view = (await page.locator(".branch-screen-view").boundingBox())!
    const conversation = (await conversationOf(page).boundingBox())!
    expect(conversation.x, "the conversation sits beside the view").toBeGreaterThanOrEqual(view.x + view.width)
    expect(conversation.height, "the conversation is a full column").toBeGreaterThan(400)
  })

/** Moves the tab to branch `to` in place, as `/navigate` does: no reload. */
const switchBranch = async (page: Page, to: string) => {
  const composer = await openComposer(page)
  await composer.fill(`/navigate ${REPO}/tree/${to}`)
  await composer.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/tree/${to}$`), { timeout: 30_000 })
  await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(to, { timeout: 30_000 })
}

/** Asks Smithers `question` in the page's conversation. */
const ask = (page: Page, question: string) =>
  step(`Ask "${question}"`, async () => {
    const composer = await openComposer(page)
    await composer.fill(question)
    await composer.press("Enter")
    await expect(questionIn(conversationOf(page), question)).toBeVisible()
  })

/**
 * Shows the person's shell on the page's branch: the terminal still open from an earlier run, or Open terminal when
 * there is none or it ended (a dev server reload restarts the machines, so an earlier run's terminal can be `lost`).
 */
const openTerminal = (page: Page) =>
  step("Open the terminal", async () => {
    const open = page.getByRole("button", { name: "Open terminal" })
    await expect(async () => {
      // isVisible answers at once; isEnabled alone would wait for a button an open terminal never shows.
      if ((await open.isVisible()) && (await open.isEnabled())) await open.click()
      await expect(terminalRows(page)).toContainText("/workspace", { timeout: 15_000 })
    }).toPass({ timeout: MACHINE })
  })

/** Types `line` into the terminal frame and presses Enter. */
const type = (page: Page, line: string) =>
  step(`Type "${line}"`, async () => {
    await page.locator('iframe[title="Terminal"]').click()
    await page.keyboard.type(line)
    await page.keyboard.press("Enter")
  })

test("branch conversation: a question asked on a branch is stored in that branch's conversation only", {
  annotation: { type: "summary", description: "Each branch has its own conversation: a question asked on one never shows on another, or at home." },
}, async ({ page }) => {
  test.setTimeout(3 * 60_000)
  const word = `branch-${Date.now()}`

  await openBranch(page, "test-branch")
  await expectWorkspace(page, "test-branch")
  const first = `Reply with exactly the word: ${word}`
  await ask(page, first)
  // Stored in Postgres in this branch's conversation: a reload shows it from the device and from Electric.
  await page.reload()
  await expect(questionIn(conversationOf(page), first)).toBeVisible({ timeout: 60_000 })

  // Another branch has its own conversation, without it.
  await openBranch(page, "change-the-title")
  await expect(questionIn(conversationOf(page), first)).toHaveCount(0)
  const second = `Second branch ${word}`
  await ask(page, second)

  // Back on test-branch: its question, not the other branch's.
  await openBranch(page, "test-branch")
  await expect(questionIn(conversationOf(page), first)).toBeVisible({ timeout: 60_000 })
  await expect(questionIn(conversationOf(page), second)).toHaveCount(0)

  // The home conversation at /app has neither.
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  await expect(questionIn(conversationOf(page), first)).toHaveCount(0)
  await expect(questionIn(conversationOf(page), second)).toHaveCount(0)
})

test("branch terminal: Open terminal runs git log on the branch's machine in a frame, and a reload keeps the shell", {
  annotation: { type: "summary", description: "A branch's terminal runs on its own machine, checked out at the branch, and a reload keeps the same shell." },
}, async ({ page }) => {
  test.setTimeout(5 * 60_000)
  const word = `shell-${Date.now()}`
  await openBranch(page, "test-branch")

  // The terminal: our xterm in an opaque-origin frame, on the branch's own machine, checked out at the branch through
  // the forge proxy. The person's terminal there is theirs again if it is still open.
  await step("Switch to the Terminal view", async () => {
    await page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Terminal" }).click()
    await expect(page).toHaveURL(/[?&]terminal=me/)
    // The terminal's screen fills the view from the start: Open terminal in its middle, or the terminal itself; never
    // a small button over a blank page (Will, 2026-10-20).
    const screen = page.getByRole("region", { name: "Terminal" }).locator(".terminal-panel-screen")
    await expect(screen).toBeVisible()
    expect((await screen.boundingBox())!.height).toBeGreaterThan(280)
    await expect(page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Terminal" })).toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Code" })).not.toHaveAttribute("aria-current", "page")
  })
  await openTerminal(page)
  await expect(page.locator('iframe[title="Terminal"]')).toHaveAttribute("sandbox", "allow-scripts")
  // The terminal fills its screen, not an 18 rem strip of it (the 2026-10-20 re-record showed the strip).
  const screen = (await page.locator(".terminal-panel-screen").boundingBox())!
  const frame = (await page.locator(".terminal-panel-frame").boundingBox())!
  expect(frame.height, "the terminal fills its screen").toBeGreaterThan(screen.height - 8)
  // The forge's branch, not HEAD: another spec's commits in this machine's checkout (the lifecycle's) sit above it.
  await type(page, "git log --oneline -3 origin/test-branch")
  await expect(terminalRows(page)).toContainText("Create test.md", { timeout: 30_000 })
  await type(page, `export KEPT=${word}; echo set-$KEPT`)
  // The shell ran it before the reload: keys still in flight when a page unloads are lost, as in any web terminal.
  await expect(terminalRows(page)).toContainText(`set-${word}`, { timeout: 30_000 })

  // A reload keeps the shell: tmux redraws the screen, and the variable set before is still set.
  await page.reload()
  await expect(terminalRows(page)).toContainText("Create test.md", { timeout: 60_000 })
  await type(page, "echo kept-$KEPT")
  await expect(terminalRows(page)).toContainText(`kept-${word}`, { timeout: 30_000 })
})

test("second branch terminal: another branch has its own machine, checkout and shell", {
  annotation: { type: "summary", description: "Another branch has its own machine: its shell is checked out at that branch and shares nothing with the first." },
}, async ({ page }) => {
  test.setTimeout(5 * 60_000)
  await openBranch(page, "change-the-title", "?terminal=me")
  await openTerminal(page)
  await type(page, "git rev-parse --abbrev-ref HEAD; echo kept-$KEPT.")
  await expect(terminalRows(page)).toContainText("change-the-title", { timeout: 30_000 })
  // test-branch's shell exported KEPT; this one is another machine's shell, where it is unset.
  await expect(terminalRows(page)).toContainText("kept-.", { timeout: 30_000 })
})

test("branch views: a page opened on a branch lands in that branch's conversation, and opens full screen from there and from its URL", {
  annotation: { type: "summary", description: "A web page opened on a branch lands in that branch's conversation and opens full screen, from there and from its link." },
}, async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await openBranch(page, "change-the-title")
  await expectWorkspace(page, "change-the-title")
  const conversation = conversationOf(page)
  const url = `https://example.com/?run=${Date.now()}`

  // `/web` on the branch, then straight to another branch in the same tab (`/navigate`) before the flow's step runs:
  // the page stays where it was asked for, because the conversation is pinned when the person dispatched it. (A reload
  // at that instant would drop a run the engine hadn't taken yet, as it would a keystroke.)
  const composer = await openComposer(page)
  await composer.fill(`/web ${url}`)
  await composer.press("Enter")
  await switchBranch(page, "test-branch")
  await switchBranch(page, "change-the-title")
  const view = conversation.locator("[data-view]", { has: page.locator(`iframe[src="${url}"]`) })
  await expect(view).toHaveCount(1, { timeout: 30_000 })
  const id = await view.getAttribute("data-view")

  // Full screen from the conversation, then the same URL loaded fresh.
  await view.getByRole("link", { name: "Full screen" }).click()
  await expect(page).toHaveURL(new RegExp(`/app/views/${id}\\?conversation=[0-9a-f-]{36}$`))
  const main = page.getByRole("main", { name: "View" })
  await expect(main.locator("iframe")).toBeVisible({ timeout: 30_000 })
  await expect(main.frameLocator("iframe").getByText("This domain is for use in documentation examples")).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(main.locator("iframe")).toBeVisible({ timeout: 30_000 })
  await expect(main.frameLocator("iframe").getByText("This domain is for use in documentation examples")).toBeVisible({ timeout: 30_000 })

  await test.info().attach("Full screen after reload", { body: await page.screenshot(), contentType: "image/png" })

  // The other branch's conversation doesn't have it.
  await openBranch(page, "test-branch")
  await expect(conversationOf(page).locator(`[data-view="${id}"]`)).toHaveCount(0)
})
