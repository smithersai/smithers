import { clipboardPermissions, readClipboard } from "./browserCapabilities"
import type { Page } from "@playwright/test"
import { expect, test, visibleText } from "./fixtures"
import { requires } from "./target"

// The repository view's extras (docs/features/repo.md#the-browser), against the real app, Worker, engine, Postgres,
// Electric and Code Storage: the branch picker, raw files by the app's link and by GitHub's raw path, Copy permalink and
// the clone URL. The fixture is the tiny public `octocat/Spoon-Knife`, whose `test-branch` adds `test.md`; nothing is
// created on GitHub. Locally the run needs the Code Storage organization in the dev server's environment; a deployment
// holds it. Every test opens the clone, asking for it if no run has, a Member's request (worker/RepoApi.ts
// `canClone`), and waits on the `repo/clone` remote flow (worker/RepoApi.ts `start`, worker/flows/RepoClone.ts).

requires("codeStorage", "member")

const REPO = "/octocat/Spoon-Knife"

/** Typing a person can follow in the video. */
const typing = { delay: 60 }

/** Clones the fixture if it isn't there yet, and waits until the repository opens on its README. */
const openReady = async (page: Page) => {
  await page.goto(REPO)
  const header = page.locator('header[aria-label="Repository"]')
  // The app's first render on a loaded machine can take seconds: the engine worker and the device store start first.
  await expect(header).toContainText("octocat / Spoon-Knife", { timeout: 30_000 })
  // GitHub's preview shows the README before anyone clones, so ready is the branch picker, which only a clone has.
  const picker = page.getByRole("button", { name: "main", exact: true })
  const clone = header.getByRole("button", { name: "Clone" })
  await expect(picker.or(clone)).toBeVisible({ timeout: 60_000 })
  if (await clone.isVisible()) await clone.click()
  await expect(picker).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText("Well hello there!")).toBeVisible({ timeout: 30_000 })
}

test("switch branch: the picker lists the branches, filters, and opens one, keeping the path's kind", { annotation: { type: "summary", description: "The branch picker lists and filters branches, and opens one at the same kind of path." } }, async ({ page }) => {
  await openReady(page)
  await page.getByRole("button", { name: "main", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Branches and tags" })
  await expect(picker.getByRole("tab", { name: /Branches/ })).toContainText("3")
  await expect(picker.getByRole("link")).toHaveCount(3)
  await picker.getByRole("textbox", { name: "Find a branch, tag or SHA" }).pressSequentially("test", typing)
  await expect(picker.getByRole("link")).toHaveCount(1)
  await picker.getByRole("link", { name: /test-branch/ }).click()
  // `app/navigate` moves the tab to the branch, and the view reads at its commit.
  await expect(page).toHaveURL(/\/octocat\/Spoon-Knife\/tree\/test-branch$/)
  await expect(page.getByRole("button", { name: "test-branch", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "test.md" }).first()).toBeVisible({ timeout: 30_000 })
  // GitHub's URL for a file on the branch opens the same file.
  await page.goto(`${REPO}/blob/test-branch/test.md`)
  await expect(page.getByRole("article", { name: "test.md" })).toBeVisible({ timeout: 30_000 })
})

test("raw: Raw opens the file as plain text in a new tab, and GitHub's raw path loads the same", { annotation: { type: "summary", description: "Raw opens a file as plain text, and GitHub's raw path opens the same." } }, async ({ page, context }) => {
  await openReady(page)
  await page.goto(`${REPO}/blob/test-branch/index.html`)
  await expect(visibleText(page.getByRole("article", { name: "index.html", exact: true }), "<!DOCTYPE html>")).toBeVisible({ timeout: 30_000 })
  const [raw] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "Raw" }).click()])
  await raw.waitForLoadState()
  expect(raw.url()).toMatch(/\/api\/repos\/octocat\/Spoon-Knife\/raw\/[0-9a-f]{40}\/index\.html$/)
  // Shown as its source, never rendered: the page's text is the HTML itself.
  await expect(raw.locator("body")).toContainText("<!DOCTYPE html>")
  await raw.close()
  const download = page.getByRole("link", { name: "Download" })
  await expect(download).toHaveAttribute("download", "index.html")
  // Swapping github.com for the app's domain on a raw URL loads the raw file at the branch's commit.
  await page.goto(`${REPO}/raw/test-branch/index.html`)
  await expect(page).toHaveURL(/\/api\/repos\/octocat\/Spoon-Knife\/raw\/[0-9a-f]{40}\/index\.html$/, { timeout: 30_000 })
  await expect(page.locator("body")).toContainText("<!DOCTYPE html>")
})

test("copy: Copy permalink, Copy path, Copy and the clone URL put what they say on the clipboard", { annotation: { type: "summary", description: "Copy permalink, Copy path, Copy and the clone URL copy what they say." } }, async ({ page, context, browserName }) => {
  await context.grantPermissions(clipboardPermissions(browserName))
  await openReady(page)
  await page.goto(`${REPO}/blob/test-branch/test.md`)
  await expect(page.getByRole("article", { name: "test.md" })).toBeVisible({ timeout: 30_000 })
  // Each Copy runs `repo/copy` on this browser's engine, which writes this tab's clipboard.
  await page.getByRole("button", { name: "Copy permalink" }).click()
  await expect.poll(() => readClipboard(browserName, page), { timeout: 30_000 }).toMatch(
    /\/octocat\/Spoon-Knife\/blob\/[0-9a-f]{40}\/test\.md$/,
  )
  const permalink = await readClipboard(browserName, page)
  await page.getByRole("button", { name: "Copy path" }).click()
  await expect.poll(() => readClipboard(browserName, page), { timeout: 30_000 }).toBe("test.md")
  await page.getByRole("button", { name: "Copy", exact: true }).click()
  await expect.poll(() => readClipboard(browserName, page), { timeout: 30_000 }).not.toBe("test.md")
  // The clone menu's Code, not a Markdown file's Preview and Code toggle: the button that opens a panel.
  await page.getByRole("button", { name: "Code" }).and(page.locator('[aria-haspopup="dialog"]')).click()
  await page.getByRole("button", { name: "Copy clone URL" }).click()
  await expect.poll(() => readClipboard(browserName, page), { timeout: 30_000 }).toBe("https://github.com/octocat/Spoon-Knife.git")
  // The permalink opens the same file, at the commit.
  await page.goto(new URL(permalink).pathname)
  await expect(page.getByRole("article", { name: "test.md" })).toBeVisible({ timeout: 30_000 })
})
