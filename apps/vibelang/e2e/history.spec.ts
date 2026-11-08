// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, type Page, test } from "@playwright/test"

// The mythical history's page (wiki/decisions/0020-mythical-history.md), on the mock: VibeLang's real bootstrapped
// history, read by epic and commit, and a task walked through the history's flows from plan to landed. Set
// MYTHICAL_SHOTS to a directory to keep a screenshot of each screen.

const shots = process.env.MYTHICAL_SHOTS

async function shot(page: Page, name: string, project: string) {
  if (shots !== undefined) await page.screenshot({ path: `${shots}/${project}-${name}.png`, fullPage: false })
}

async function open(page: Page, query = "") {
  await page.goto(`/history?agent=mock${query}`)
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
}

test.describe("the history page", () => {
  test("shows the outline first, reading only what it shows", async ({ page }) => {
    // Against a live deployment (E2E_BASE_URL) the page reads the History object; on the preview, the mock.
    const reads: Array<{ readonly path: string; readonly bytes: number }> = []
    page.on("response", async (response) => {
      const url = new URL(response.url())
      if (!url.pathname.startsWith("/api/history") || url.pathname.endsWith("/events")) return
      reads.push({ path: url.pathname + url.search, bytes: (await response.body().catch(() => Buffer.alloc(0))).length })
    })
    const begin = Date.now()
    await page.goto("/history")
    const compiler = page.getByRole("button", { name: /The compiler/ })
    await expect(compiler).toBeVisible({ timeout: 20_000 })
    const shown = Date.now() - begin
    const mode = await page.locator("[data-surface=history]").getAttribute("data-mode")
    await compiler.click()
    await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link")).toHaveCount(50)
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await expect(page.locator(".mh-note-sections")).toBeVisible()
    if (mode !== "live") return
    expect(shown).toBeLessThan(1000)
    expect(reads.map((read) => read.path.replace(/\d+/g, "N"))).toEqual(["/api/history", "/api/history/epics/eN?from=N", "/api/history/commits/mN"])
    for (const read of reads) expect(read.bytes).toBeLessThan(32 * 1024)
  })


  test("the agent in the chat reads the history through its tool", async ({ page }, testInfo) => {
    await page.goto("/?agent=mock")
    await page.keyboard.press("ControlOrMeta+k")
    await page.getByRole("textbox", { name: "Message" }).pressSequentially("What is in the mythical history?")
    await page.keyboard.press("Enter")
    const answer = page.locator(".sui-chat-message[data-role='assistant']")
    await expect(answer).toHaveAttribute("data-done", "true", { timeout: 20_000 })
    await expect(answer).toContainText(/VibeLang's mythical history, folded through [0-9a-f]{12}\./)
    await expect(answer).toContainText(/The compiler \d+ · /)
    await shot(page, "chat-history", testInfo.project.name)
    await page.getByRole("link", { name: "History" }).click()
    await expect(page).toHaveURL(/\/history$/)
    await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
  })

  test("lists VibeLang's epics, opens one and a commit with its notes and real commits", async ({ page }, testInfo) => {
    await open(page)
    await expect(page.getByText("Mock", { exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: "Minimize" })).toHaveAttribute("href", "/")
    await expect(page.getByRole("button", { name: /^Foundations/ })).toBeVisible()
    await shot(page, "history", testInfo.project.name)

    const compiler = page.getByRole("button", { name: /The compiler/ })
    await expect(compiler).toHaveAttribute("aria-expanded", "false")
    await compiler.focus()
    await page.keyboard.press("Enter")
    await expect(compiler).toHaveAttribute("aria-expanded", "true")
    const commits = page.getByRole("list", { name: "The compiler" }).getByRole("link")
    await expect(commits).toHaveCount(50)
    await page.getByRole("button", { name: "Show more" }).click()
    await expect(commits).toHaveCount(100)
    await shot(page, "epic-open", testInfo.project.name)

    await commits.first().click()
    await expect(page).toHaveURL(/#m\d+$/)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await expect(page.locator(".mh-note-sections > div > .sui-label")).toHaveText(["Tried", "Evidence", "Folded", "Superseded"])
    const real = page.locator(".mh-note-list a[href^='https://github.com/smithersai/vibelang/commit/']")
    await expect.poll(() => real.count()).toBeGreaterThan(0)
    await shot(page, "commit", testInfo.project.name)

    await page.getByRole("link", { name: "History", exact: true }).click()
    await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible()
  })

  test("a commit's notes say what the merge queue refused before it landed", async ({ page }, testInfo) => {
    await open(page)
    await page.getByRole("searchbox", { name: "Filter commits" }).fill("register the computed-key match witness once")
    const match = page.getByRole("list", { name: "Matching commits" }).getByRole("link").first()
    await expect(match).toBeVisible()
    await match.click()
    await expect(page.getByText(/^Rejected in the merge queue/).first()).toBeVisible()
    await expect(page.getByText(/^Landed by the merge queue from lane .* \(matched by title\)\./)).toBeVisible()
    await shot(page, "commit-tried", testInfo.project.name)
  })

  test("walks a task from planned to landed: plan, start, note, approve, fold", async ({ page }, testInfo) => {
    await open(page)
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel("Commit")).toBeFocused()
    await dialog.getByLabel("Commit").fill("fix(compiler): retry a fork once before failing")
    await dialog.getByLabel("Epic").selectOption({ label: "The compiler" })
    await dialog.getByLabel("Task").fill("issue 412")
    await shot(page, "plan", testInfo.project.name)
    await dialog.getByRole("button", { name: "Plan work" }).click()

    await expect(page).toHaveURL(/#m\d+$/)
    const id = new URL(page.url()).hash.slice(1)
    await expect(page.getByRole("heading", { level: 1, name: "fix(compiler): retry a fork once before failing" })).toBeVisible()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("planned")

    await page.getByLabel("Lane").fill("lane-a")
    await page.getByRole("button", { name: "Start" }).click()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("working")
    await page.getByLabel("Section").selectOption("tried")
    await page.getByLabel("Note", { exact: true }).fill("A cache first; it went stale.")
    await page.getByRole("button", { name: "Add note" }).click()
    await expect(page.getByText("A cache first; it went stale.")).toBeVisible()
    await shot(page, "work", testInfo.project.name)

    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("approved")

    await page.getByRole("link", { name: "History", exact: true }).click()
    await expect(page.getByRole("list", { name: "Planned" })).toContainText("fix(compiler): retry a fork once before failing")
    await shot(page, "planned", testInfo.project.name)
    await page.getByRole("button", { name: "Fold" }).click()
    await expect(page.getByRole("list", { name: "Planned" })).toHaveCount(0)

    await page.goto(`/history?agent=mock#${id}`)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 })
  })

  test("shows a viewer no action, and a contributor no retelling", async ({ page }) => {
    await open(page, "&role=viewer")
    await expect(page.getByRole("button", { name: "Plan work" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Fold" })).toHaveCount(0)
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await expect(page.getByRole("button", { name: "Add note" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Amend…" })).toHaveCount(0)

    await open(page, "&role=contributor")
    await expect(page.getByRole("button", { name: "Plan work" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Fold" })).toHaveCount(0)
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await expect(page.getByRole("button", { name: "Add note" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Amend…" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Insert before…" })).toHaveCount(0)
  })

  test("amends a landed commit as a maintainer, and Escape closes the dialog", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await page.getByRole("button", { name: "Amend…" }).click()
    const dialog = page.getByRole("dialog", { name: "Amend" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel("Task")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await page.getByRole("button", { name: "Amend…" }).click()
    await expect(dialog.getByLabel("Task")).toBeFocused()
    await dialog.getByLabel("Task").fill("issue 9")
    await dialog.getByRole("button", { name: "Amend" }).click()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("planned")
    await expect(page.locator(".mh-meta")).toContainText("issue 9")
  })
})
