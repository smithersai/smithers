// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

// The history page over a faulty Mythical (e2e/history-runtime, test/support/FaultyMythical.vibe): each named fault
// happens once, then the real mock history answers.

const UNREACHABLE = "The history can't be reached."

async function open(page: Page, fault: string, ready = true) {
  await page.goto(`/e2e/history-runtime/index.html?agent=mock&fault=${fault}`)
  if (ready) await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
}

test.describe("the history page when the history fails", () => {
  test("a failed load says so, and Retry loads the history", async ({ page }) => {
    await open(page, "outline", false)
    const alert = page.getByRole("alert")
    await expect(alert).toContainText("Couldn't load the history.", { timeout: 20_000 })
    await expect(page.getByRole("button", { name: /The compiler/ })).toHaveCount(0)
    await alert.getByRole("button", { name: "Retry" }).click()
    await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)
  })

  test("a history with no epics says so", async ({ page }) => {
    await open(page, "empty", false)
    await expect(page.getByText("No mythical history yet.")).toBeVisible({ timeout: 20_000 })
  })

  test("a history nothing is folded into yet shows no folded-through commit", async ({ page }) => {
    await open(page, "unfolded")
    await expect(page.getByTitle("Folded through")).toHaveCount(0)
  })

  test("a commit newer than the outline shows no epic until the outline reads again", async ({ page }) => {
    await open(page, "reads")
    // Spend the one failed search and commit read first.
    const filter = page.getByRole("searchbox", { name: "Filter commits" })
    await filter.fill("retry")
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await filter.fill("register the computed-key match witness once")
    await page.getByRole("list", { name: "Matching commits" }).getByRole("link").first().click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await page.getByRole("link", { name: "History", exact: true }).click()

    // The plan's event reads the outline, which fails: the outline doesn't hold the new epic.
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Epic").selectOption({ label: "New epic…" })
    await dialog.getByLabel("New epic").fill("Later")
    await dialog.getByLabel("Commit").fill("fix(history): ahead of the outline")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "fix(history): ahead of the outline" })).toBeVisible()
    const trail = page.getByRole("navigation", { name: "Breadcrumbs" })
    await expect(trail.getByRole("link", { name: "History", exact: true })).toBeVisible()
    await expect(trail.getByRole("link", { name: "Later", exact: true })).toHaveCount(0)

    await trail.getByRole("link", { name: "History", exact: true }).click()
    await filter.fill("ahead of the outline")
    const match = page.getByRole("list", { name: "Matching commits" }).getByRole("link", { name: "fix(history): ahead of the outline" })
    await expect(match).toBeVisible()
    await expect(match).not.toContainText("Later")

    // The next event reads the outline again, and the commit's epic appears.
    await match.click()
    await page.getByLabel("Lane").fill("lane-a")
    await page.getByRole("button", { name: "Start" }).click()
    await expect(trail.getByRole("link", { name: "Later", exact: true })).toBeVisible()
  })

  test("a failed epic, commit or search read says so, and reading again recovers", async ({ page }) => {
    await open(page, "reads")
    const compiler = page.getByRole("button", { name: /The compiler/ })
    await compiler.click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await compiler.click()
    await compiler.click()
    const commits = page.getByRole("list", { name: "The compiler" }).getByRole("link")
    await expect(commits).toHaveCount(50)

    await commits.first().click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await page.getByRole("link", { name: "History", exact: true }).click()
    await commits.first().click()
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

    await page.getByRole("link", { name: "History", exact: true }).click()
    const filter = page.getByRole("searchbox", { name: "Filter commits" })
    await filter.fill("retry")
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await filter.fill("register the computed-key match witness once")
    await expect(page.getByRole("list", { name: "Matching commits" }).getByRole("link").first()).toBeVisible()

    // The plan's event reads the outline, which fails once; the next event reads again.
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Commit").fill("fix(history): read again after a failed read")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "fix(history): read again after a failed read" })).toBeVisible()
    await page.getByLabel("Lane").fill("lane-a")
    await page.getByRole("button", { name: "Start" }).click()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("working")
  })

  test("a failed write says so in the page's words, and the next one is written", async ({ page }) => {
    await open(page, "writes")
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Commit").fill("fix(history): say when a write fails")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(dialog.getByRole("alert")).toHaveText(UNREACHABLE)
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "fix(history): say when a write fails" })).toBeVisible()
    const state = page.locator(".mh-meta .sui-badge").first()

    await page.getByLabel("Lane").fill("lane-a")
    await page.getByRole("button", { name: "Start" }).click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await expect(state).toHaveText("planned")
    await page.getByLabel("Lane").fill("lane-a")
    await page.getByRole("button", { name: "Start" }).click()
    await expect(state).toHaveText("working")

    await page.getByLabel("Note", { exact: true }).fill("A cache first.")
    await page.getByRole("button", { name: "Add note" }).click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await page.getByLabel("Note", { exact: true }).fill("A cache first.")
    await page.getByRole("button", { name: "Add note" }).click()
    await expect(page.getByText("A cache first.")).toBeVisible()

    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await page.getByRole("button", { name: "Approve" }).click()
    await expect(state).toHaveText("approved")

    await page.getByRole("link", { name: "History", exact: true }).click()
    await page.getByRole("button", { name: "Fold" }).click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await page.getByRole("button", { name: "Fold" }).click()
    await expect(page.getByRole("list", { name: "Planned" })).toHaveCount(0)
  })

  test("a lost event stream follows again, so the page shows its own writes", async ({ page }) => {
    await open(page, "events")
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Commit").fill("fix(history): plan without events")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "fix(history): plan without events" })).toBeVisible()
    await page.getByLabel("Lane").fill("lane-a")
    await page.getByRole("button", { name: "Start" }).click()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("working")
  })
})
