import type { Page, Request } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { requires } from "./target"

// Clicking files in a branch's tree (docs/features/navigation.md#files-in-the-tree), signed in, against the real app,
// Worker, Postgres, Electric, GitHub and Code Storage. Will, 2026-10-31: every click "is slower than it should be" and
// "the entire page refreshes after a second". Each click re-tracked the branch: the workspace's chrome and its
// conversation unmounted at once and came back when ChatApi answered, about a second later. Here a person hovers a file
// for 150 ms, then clicks it, for several files in a row: the page never loads again, the workspace never leaves the
// screen for one frame, the file shows within a frame or two of the click, and the click asks ChatApi nothing the
// hover or the tree already had.

requires("codeStorage", "member")

const REPO = "/octocat/Spoon-Knife"
const FILES = ["README.md", "index.html", "styles.css"] as const

/** Requests a click must not make again: the branch's refs, the person's role, the home, and tracking the branch. */
const REPEATED = /\/api\/repos\/[^/]+\/[^/]+\/(refs|role|home)(\?|$)|\/api\/branches(\?|$)/

/** Opens Spoon-Knife's tree at `main`, cloning it if no run has yet, and waits for the branch's workspace. */
const openTree = (page: Page) =>
  step("Open Spoon-Knife's tree", async () => {
    await page.goto(REPO)
    const header = page.locator('header[aria-label="Repository"]')
    await expect(header).toContainText("octocat / Spoon-Knife", { timeout: 30_000 })
    const picker = page.getByRole("button", { name: "main", exact: true })
    const clone = header.getByRole("button", { name: "Clone" })
    await expect(picker.or(clone)).toBeVisible({ timeout: 60_000 })
    if (await clone.isVisible()) await clone.click()
    await expect(picker).toBeVisible({ timeout: 120_000 })
    await page.goto(`${REPO}/tree/main`)
    await expect(page.getByRole("navigation", { name: "Branch" })).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('main.branch-screen[data-workspace="true"]')).toBeVisible()
  })

/**
 * Watches, every frame from now, whether the branch's workspace is on screen and, once `clicked()` is called, when
 * `text` first shows in the file's view. Answers what it saw.
 */
const watchFrames = (page: Page, file: string, text: string) =>
  page.evaluate(([file, text]) => {
    const w = window as unknown as { __treeClick: { gaps: number; clickedAt?: number; shownAt?: number; frames: number } }
    w.__treeClick = { gaps: 0, frames: 0 }
    const tick = () => {
      const state = w.__treeClick
      const workspace = document.querySelector('main.branch-screen[data-workspace="true"] nav[aria-label="Branch"]') !== null
      if (!workspace) state.gaps++
      if (state.clickedAt !== undefined) {
        state.frames++
        // The file's own view: its Raw link and its first line (the tree's README shows the line, never the link).
        const view = document.querySelector(".branch-screen-view")
        if (state.shownAt === undefined && view?.querySelector(`a[href*="/raw/"][href$="/${file}"]`) != null &&
          (view.textContent ?? "").includes(text)) state.shownAt = performance.now()
      }
      if (state.frames < 300) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    document.addEventListener("click", () => {
      w.__treeClick.clickedAt = performance.now()
    }, { capture: true, once: true })
  }, [file, text] as const)

const framesSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __treeClick: { gaps: number; clickedAt?: number; shownAt?: number } }).__treeClick)

/** A line each file's view shows: the first of its own lines with words in it. */
const FIRST_LINE: Record<(typeof FILES)[number], string> = {
  "README.md": "Well hello there!",
  "index.html": "<!DOCTYPE html>",
  "styles.css": "* {",
}

test(
  "a file clicked in the tree after a hover shows at once, and the page never loads again",
  { annotation: { type: "summary", description: "Hover, then click three files: no reload, no unmounted workspace, no repeated request" } },
  async ({ page }) => {
    test.setTimeout(300_000)
    await openTree(page)

    const documents: Array<string> = []
    const repeated: Array<string> = []
    let clicking = false
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url())
      if (clicking && REPEATED.test(new URL(request.url()).pathname + new URL(request.url()).search)) {
        repeated.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    }
    page.on("request", onRequest)
    const tree = page.locator(".branch-screen-view")

    const timings: Array<{ file: string; ms: number; frames: number }> = []
    for (const file of FILES) {
      await step(`Hover, then click ${file}`, async () => {
        const link = tree.locator(`a[href$="/blob/main/${file}"]`).first()
        await expect(link).toBeVisible({ timeout: 30_000 })
        // The hover preloads the file (the router's intent preload): hover for 150 ms and, when the device didn't have
        // the file yet, until its read answered. A warm device reads nothing, so the wait ends at its bound.
        const read = page.waitForResponse((response) => response.url().includes("/blob/") && response.url().includes(file), { timeout: 5_000 })
          .catch(() => undefined)
        await link.hover()
        await Promise.all([page.waitForTimeout(150), read])
        await watchFrames(page, file, FIRST_LINE[file])
        clicking = true
        await link.click()
        await expect(page).toHaveURL(new RegExp(`/blob/main/${file.replace(".", "\\.")}$`))
        await expect.poll(async () => (await framesSeen(page)).shownAt, { timeout: 10_000 }).toBeDefined()
        // Five seconds for a reload or a late unmount to happen.
        await page.waitForTimeout(5_000)
        clicking = false
        const seen = await framesSeen(page)
        const ms = seen.shownAt! - seen.clickedAt!
        timings.push({ file, ms: Math.round(ms), frames: Math.ceil(ms / (1000 / 60)) })
        expect(seen.gaps, "frames the branch's workspace was off screen").toBe(0)
        expect(documents, "the page loaded again").toEqual([])
      })
      await step("Back to the tree", async () => {
        clicking = false
        await page.goBack()
        await expect(page).toHaveURL(new RegExp(`${REPO}/tree/main$`))
      })
    }
    page.off("request", onRequest)
    test.info().annotations.push({ type: "timings", description: JSON.stringify(timings) })
    expect(repeated, "requests a click made again").toEqual([])
    expect(documents).toEqual([])
    // A warm, hovered file shows within a few frames of its click: the bound leaves room for a loaded test machine,
    // and the timings annotation keeps the measured value (docs/features/navigation.md).
    for (const timing of timings) expect(timing.ms, `${timing.file}: ms from click to its first line`).toBeLessThan(100)
  },
)
