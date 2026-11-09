// The first paint never blocks a person (docs/features/issues.md#first-paint, decision 0152): on a new device, with the
// issue rows held back so the page stays syncing, search and New issue take a real click and the painted rows stay
// on the page beside them. A click Playwright can't land, because something covers the control, fails the test.
import type { Page } from "@playwright/test"
import type { EndRecord } from "../src/firstPaint/shell"
import { expect, test } from "./fixtures"
import { requires, target } from "./target"
import { expectServerError } from "./watch"

if (target === "deployment") requires("trackingRepository")
else requires("noGitHubApp")

const repo = target === "local" ? "octocat/Spoon-Knife" : process.env.E2E_TRACKING_REPOSITORY ?? ""
const painted = "smithers.first_paint.painted"

// Local development seeds its own real synced issue through the normal issues read.
test.beforeAll(async ({ request }) => {
  if (target !== "local") return
  const response = await request.get(`/api/repos/${repo}/issues?state=all&limit=1`)
  expect(response.status()).toBe(200)
  expect((await response.json()).length).toBeGreaterThan(0)
})

// Retain the actual terminal marks even when an assertion fails. No paths, titles, viewers or response bodies.
const paintRecords = (page: Page) => page.evaluate(() => performance.getEntriesByType("mark")
  .filter((entry) => entry.name.startsWith("smithers.first_paint."))
  .map((entry) => ({ name: entry.name.slice("smithers.first_paint.".length), at: entry.startTime, detail: (entry as PerformanceMark).detail as EndRecord | null })))

test.afterEach(async ({ page }, info) => {
  const marks = await paintRecords(page)
  await info.attach("first-paint-outcomes", { body: JSON.stringify(marks, null, 2), contentType: "application/json" })
  // The deployment owns browser telemetry; a zone-injected beacon must not return.
  await expect(page.locator("script[src^=\"https://static.cloudflareinsights.com/\"]")).toHaveCount(0)
})

// The About read of a private repository answers 404 for anyone: it reads what GitHub says publicly. WebKit reports a
// worker's failed request on the page's console, and the engine worker makes this one; Chromium doesn't.
// This private issues-only fixture has no readable public metadata or Code Storage mirror.
expectServerError(404, `/api/repos/${repo}/about`)
expectServerError(404, `/api/repos/${repo}/refs`)

test("a list still syncing: the painted rows sit under search and New issue, which both work", async ({ page }) => {
  // The page's own rows never arrive during this test.
  await page.route("**/api/shapes/item-summaries*", () => undefined)
  await page.goto(`/${repo}/issues`)
  await expect(page.locator("#first-paint li").first()).toBeVisible({ timeout: 30_000 })
  const search = page.getByRole("textbox", { name: "Search issues" })
  await search.click({ timeout: 30_000 })
  await expect(search).toBeFocused()
  await expect(page.locator("#first-paint[data-placed] li").first()).toBeVisible()
  // An unrelated About failure must not settle the authorized list and discard its painted rows.
  await expect(page.getByText("Issues unavailable", { exact: true })).toHaveCount(0)
  expect(await page.evaluate((mark) => performance.getEntriesByName(mark).length, painted)).toBe(1)
  // The controls sit above the rows; nothing lies over them.
  const newIssue = page.getByRole("link", { name: "New issue" })
  await newIssue.click({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues/new`))
  await expect(page.locator("#first-paint")).toHaveCount(0)
})

test("typing a search takes the painted rows away: they were never its answer", async ({ page }) => {
  await page.route("**/api/shapes/item-summaries*", () => undefined)
  await page.goto(`/${repo}/issues`)
  await expect(page.locator("#first-paint li").first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole("textbox", { name: "Search issues" }).fill("#1", { timeout: 30_000 })
  await expect(page.locator("#first-paint")).toHaveCount(0)
})

test("an issue still syncing: its painted title sits in the page, whose links work", async ({ page, request }) => {
  await page.route("**/api/shapes/item-summaries*", () => undefined)
  // Nor does the issue's own shape: its answer settles the page, which ends the paint as handed over before the click.
  await page.route("**/api/shapes/items?*", () => undefined)
  const [issue] = (await (await request.get(`/api/repos/${repo}/issues?state=all&limit=1`)).json()) as Array<{ number: number; title: string }>
  await page.goto(`/${repo}/issues/${issue!.number}`)
  // The shell's placed title or the page's early read: both are real, authorized content while Electric is held.
  await expect(page.locator("main.issues-screen h1").filter({ hasText: issue!.title })).toContainText(`#${issue!.number}`, { timeout: 30_000 })
  // The screen's back button: every state of the screen has it. The repository header's section link has the same name
  // and target, and may not be there yet.
  await page.locator('main.issues-screen a[data-slot="button"]', { hasText: /^Issues$/ }).click({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues$`))
  // Another route: the title it read goes, for that reason and not the 30 s cap.
  await expect(page.locator("#first-paint")).toHaveCount(0)
  const marks = await paintRecords(page)
  const progress = new Set(["painted", "hand_over_waiting", "hand_over_ready", "search", "search_answer", "search_withheld"])
  const endings = marks.filter((entry) => !progress.has(entry.name))
  expect(endings, JSON.stringify(marks)).toHaveLength(1)
  const end = endings[0]!
  const paints = marks.filter((entry) => entry.name === "painted")
  // Decision 0152 permits a missed shell read; the authorized early read supplies the title in that case.
  // It cannot be counted as a hand-over. A paint that did appear must still end exactly once by hand-over/navigation.
  if (end.name === "none") {
    expect(paints).toHaveLength(0)
    expect(end.detail).toMatchObject({ previous: "pending", connected: false })
    expect(["response", "request", "lock"]).toContain(end.detail!.trigger)
  } else {
    expect(["navigated", "handed_over"]).toContain(end.name)
    expect(paints).toHaveLength(end.detail!.previous === "painted" ? 1 : 0)
  }
})
