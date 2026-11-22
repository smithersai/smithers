// Production deploy smoke for first paint and issue controls (docs/infrastructure.md#the-deploy-smoke):
// unlike e2e/first-paint.spec.ts (which injects localServer shape holds), this spec runs against a live
// deployment with zero request interception and proves that search, New issue, and issue-detail navigation
// work cleanly on the deployed build without any overlay blocking controls.
import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("trackingRepository")

const repo = process.env.E2E_TRACKING_REPOSITORY ?? ""

// The About and refs reads of this private issues-only fixture answer 404 (no public metadata or mirror).
expectServerError(404, `/api/repos/${repo}/about`)
expectServerError(404, `/api/repos/${repo}/refs`)

test("issues list: search and New issue take real clicks without any overlay covering them", async ({ page }) => {
  await page.goto(`/${repo}/issues`)
  const search = page.getByRole("textbox", { name: "Search issues" })
  await search.click({ timeout: 30_000 })
  await expect(search).toBeFocused()
  await search.fill("#1")
  await expect(page.locator("#first-paint")).toHaveCount(0)

  const newIssue = page.getByRole("link", { name: "New issue" })
  await newIssue.click({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues/new`))
  await expect(page.locator("#first-paint")).toHaveCount(0)
})

test("issue detail: renders the issue heading and returns to the issues list", async ({ page, request }) => {
  const response = await request.get(`/api/repos/${repo}/issues?state=all&limit=1`)
  expect(response.status()).toBe(200)
  const [issue] = (await response.json()) as Array<{ number: number; title: string }>
  expect(issue).toBeDefined()

  await page.goto(`/${repo}/issues/${issue!.number}`)
  await expect(page.locator("main.issues-screen h1").filter({ hasText: issue!.title }))
    .toContainText(`#${issue!.number}`, { timeout: 30_000 })
  await page.locator('main.issues-screen a[data-slot="button"]', { hasText: /^Issues$/ }).click({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues$`))
  await expect(page.locator("#first-paint")).toHaveCount(0)
})
