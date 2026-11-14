// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

// The history page's refusals and its epic page, on the real mock history (wiki/decisions/0020-mythical-history.md).

async function open(page: Page, hash = "") {
  await page.goto(`/history?agent=mock${hash}`)
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
}

test.describe("the history page's refusals and epic page", () => {
  test("refuses a plan without a title in the page's words, then plans it", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Task").fill("issue 7")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(dialog.getByRole("alert")).toHaveText("Needs a title.")
    await expect(page).not.toHaveURL(/#m\d+$/)
    await dialog.getByLabel("Commit").fill("fix(compiler): name the refused plan")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "fix(compiler): name the refused plan" })).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)
  })

  test("plans the first commit of a new epic", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Epic").selectOption({ label: "New epic…" })
    await dialog.getByLabel("New epic").fill("Coverage")
    await dialog.getByLabel("Commit").fill("test(coverage): a first journey")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "test(coverage): a first journey" })).toBeVisible()
    await page.getByRole("link", { name: "Coverage", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Coverage" })).toBeVisible()
    await expect(page.getByRole("list", { name: "Coverage" }).getByRole("link")).toHaveText([/test\(coverage\): a first journey/])
  })

  test("a maintainer exports, files evidence and a superseded note, and plans before a commit", async ({ page }) => {
    await open(page, "&role=maintainer")
    const epic = page.getByRole("button", { name: /The compiler/ })
    await expect(epic).toHaveAttribute("aria-expanded", "false")
    await epic.focus()
    await epic.press("a")
    await expect(epic).toHaveAttribute("aria-expanded", "false")
    await epic.press(" ")
    await expect(epic).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(page.getByTitle("Exported")).toHaveText(/^mythical \S{1,7}$/)
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    for (const [section, text] of [["evidence", "A bench run held it."], ["superseded", "A later fold replaced it."]] as const) {
      await page.getByLabel("Section").selectOption(section)
      await page.getByLabel("Note", { exact: true }).fill(text)
      await page.getByRole("button", { name: "Add note" }).click()
      await expect(page.getByText(text)).toBeVisible()
    }
    await page.getByRole("button", { name: "Insert before…" }).click()
    await expect(page.getByRole("dialog").getByText("Before", { exact: true })).toBeVisible()
  })

  test("an open plan keeps naming its commit after the page goes back", async ({ page }) => {
    await open(page, "&role=maintainer")
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await expect(page).toHaveURL(/#m\d+$/)
    const id = new URL(page.url()).hash.slice(1)
    await page.getByRole("button", { name: "Insert before…" }).click()
    const target = page.getByRole("dialog").locator(".mh-mono")
    await expect(target).toHaveText(new RegExp(`^${id} \\S`))
    // The dialog stays open over the list; the commit it plans before is still named, by its id.
    await page.goBack()
    await expect(page).not.toHaveURL(/#m\d+$/)
    await expect(target).toHaveText(id)
  })

  test("opens an epic's page from a commit's crumb, and from its address", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await page.getByRole("link", { name: "The compiler", exact: true }).click()
    await expect(page).toHaveURL(/#e\d+$/)
    const epic = new URL(page.url()).hash
    await expect(page.getByRole("heading", { level: 1, name: "The compiler" })).toBeVisible()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText(/^\d+ commits$/)
    await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link")).toHaveCount(50)

    await page.goto(`/history?agent=mock${epic}`)
    await expect(page.getByRole("heading", { level: 1, name: "The compiler" })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link")).toHaveCount(50)
  })

  test("folds main's commits from outside the queue under the epic their scope names", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: "Fold" }).click()
    await expect(page.locator(".sui-badge[title='Folded through']")).toContainText("0c6cea2cde78")
    const folded: ReadonlyArray<readonly [string, string, string]> = [
      ["fix(compiler): preserve reverse-mapped declaration cycle structure", "The compiler", "301689a33565"],
      ["docs(terminal): distinguish line input from raw key events", "Foundations", "0c40c2c6e9a0"],
      ["📝 docs(vips): add VIP-43, theorem and spec, as open", "Foundations", "0c6cea2cde78"],
    ]
    for (const [title, epic, sha] of folded) {
      await page.getByRole("searchbox", { name: "Filter commits" }).fill(title)
      await page.getByRole("list", { name: "Matching commits" }).getByRole("link").first().click()
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
      await expect(page.getByRole("link", { name: epic, exact: true })).toBeVisible()
      await expect(page.locator(`.mh-note-list a[href='https://github.com/smithersai/vibelang/commit/${sha}']`)).toBeVisible()
      await page.getByRole("link", { name: "History", exact: true }).click()
    }
  })

  test("refuses what the history can't hold, in the page's words", async ({ page }) => {
    const long = "x".repeat(201)
    await open(page)
    await page.getByRole("button", { name: "Plan work" }).click()
    const plan = page.getByRole("dialog", { name: "Plan work" })
    await plan.getByLabel("Commit").fill(long)
    await plan.getByRole("button", { name: "Plan work" }).click()
    await expect(plan.getByRole("alert")).toHaveText("Too long.")
    await plan.getByLabel("Commit").fill("fix(history): hold what fits")
    await plan.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "fix(history): hold what fits" })).toBeVisible()
    const state = page.locator(".mh-meta .sui-badge").first()

    await page.getByLabel("Lane").fill(long)
    await page.getByRole("button", { name: "Start" }).click()
    await expect(page.getByRole("alert")).toHaveText("Too long.")
    await expect(state).toHaveText("planned")
    await page.getByLabel("Lane").fill("lane-a")
    await page.getByRole("button", { name: "Start" }).click()
    await expect(state).toHaveText("working")

    await page.getByLabel("Note", { exact: true }).fill("n".repeat(1001))
    await page.getByRole("button", { name: "Add note" }).click()
    await expect(page.getByRole("alert")).toHaveText("Too long.")

    await page.getByRole("link", { name: "History", exact: true }).click()
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await page.getByRole("button", { name: "Amend…" }).click()
    const amend = page.getByRole("dialog", { name: "Amend" })
    await amend.getByLabel("Task").fill(long)
    await amend.getByRole("button", { name: "Amend" }).click()
    await expect(amend.getByRole("alert")).toHaveText("Too long.")
  })

  test("exports the same history twice to the same commit", async ({ page }) => {
    await open(page)
    const exported = page.getByTitle("Exported")
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(exported).toHaveText(/^mythical \S{7}$/)
    const first = await exported.textContent()
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect(exported).toHaveText(first!)
  })

  // Split from the export above: both in one test outran the test's budget under the full gate's load.
  test("exports again after a note and a plan, over what it published before", async ({ page }) => {
    await open(page)
    const exported = page.getByTitle("Exported")
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(exported).toHaveText(/^mythical \S{7}$/)
    const first = await exported.textContent()

    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await page.getByLabel("Note", { exact: true }).fill("A second export carries this.")
    await page.getByRole("button", { name: "Add note" }).click()
    await expect(page.getByText("A second export carries this.")).toBeVisible()
    await page.getByRole("link", { name: "History", exact: true }).click()
    await page.getByRole("button", { name: "Plan work" }).click()
    const plan = page.getByRole("dialog", { name: "Plan work" })
    await plan.getByLabel("Commit").fill("docs(history): export again")
    await plan.getByRole("button", { name: "Plan work" }).click()
    await page.getByRole("link", { name: "History", exact: true }).click()
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(exported).not.toHaveText(first!)
    await expect(exported).toHaveText(/^mythical \S{7}$/)
  })
})

