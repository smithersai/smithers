// The first paint never blocks a person (docs/features/issues.md#first-paint, decision 0152): on a new device, with the
// issue rows held back so the page stays syncing, search and New issue take a real click and the painted rows stay
// on the page beside them. A click Playwright can't land, because something covers the control, fails the test.
import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("trackingRepository")

const repo = process.env.E2E_TRACKING_REPOSITORY ?? ""
const painted = "smithers.first_paint.painted"

// The About read of a private repository answers 404 for anyone: it reads what GitHub says publicly. WebKit reports a
// worker's failed request on the page's console, and the engine worker makes this one; Chromium doesn't.
expectServerError(404, `/api/repos/${repo}/about`)

test("a list still syncing: the painted rows sit under search and New issue, which both work", async ({ page }) => {
  // The page's own rows never arrive during this test.
  await page.route("**/api/shapes/item-summaries*", () => undefined)
  await page.goto(`/${repo}/issues`)
  await expect(page.locator("#first-paint li").first()).toBeVisible({ timeout: 30_000 })
  const search = page.getByRole("textbox", { name: "Search issues" })
  await search.click({ timeout: 30_000 })
  await expect(search).toBeFocused()
  await expect(page.locator("#first-paint[data-placed] li").first()).toBeVisible()
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
  const [issue] = (await (await request.get(`/api/repos/${repo}/issues?state=all&limit=1`)).json()) as Array<{ number: number }>
  await page.goto(`/${repo}/issues/${issue!.number}`)
  await expect(page.locator("#first-paint[data-placed] h1")).toContainText(`#${issue!.number}`, { timeout: 30_000 })
  // The screen's back button: every state of the screen has it. The repository header's section link has the same name
  // and target, and may not be there yet.
  await page.locator('main.issues-screen a[data-slot="button"]', { hasText: /^Issues$/ }).click({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues$`))
  // Another route: the title it read goes, for that reason and not the 30 s cap.
  await expect(page.locator("#first-paint")).toHaveCount(0)
  expect(await page.evaluate(() => performance.getEntriesByName("smithers.first_paint.navigated").length)).toBe(1)
})
