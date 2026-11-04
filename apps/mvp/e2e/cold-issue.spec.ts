import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("trackingRepository")
const repo = process.env.E2E_TRACKING_REPOSITORY ?? ""
// This private issues-only fixture has no readable public metadata or Code Storage mirror.
expectServerError(404, `/api/repos/${repo}/about`)
expectServerError(404, `/api/repos/${repo}/refs`)

test("a direct cold issue paints its real heading when the shell and Electric cannot answer", async ({ page, request }) => {
  const response = await request.get(`/api/repos/${repo}/issues?state=all&limit=1`)
  expect(response.ok()).toBe(true)
  const [issue] = await response.json() as Array<{ number: number; title: string }>
  // Fault injection holds transport, never supplies a substitute answer. The early issues read reaches the real API.
  await page.route("**/api/repos/*/*/first-paint?*", () => undefined)
  for (const shape of ["items", "item-summaries", "comments"]) await page.route(`**/api/shapes/${shape}?*`, () => undefined)
  const early = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === `/api/repos/${repo}/issues` && url.searchParams.get("q") === `#${issue!.number}`
  })
  const cancelled = page.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === `/api/repos/${repo}/first-paint`)
  await page.goto(`/${repo}/issues/${issue!.number}`)
  expect((await early).ok()).toBe(true)
  await expect(page.locator("main.issues-screen h1").filter({ hasText: issue!.title })).toContainText(`#${issue!.number}`, { timeout: 30_000 })
  await expect(page.getByText("Syncing issue…", { exact: true })).toHaveCount(0)
  // The shell aborts the deliberately held read at its deadline or handoff. WebKit reports both spellings.
  expect((await cancelled).failure()?.errorText).toMatch(/^(net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/)
  await page.locator('main.issues-screen a[data-slot="button"]', { hasText: /^Issues$/ }).click()
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues$`))
})


test("a held-sync list restores its title search after opening an issue and browser Back", async ({ page, request }) => {
  const response = await request.get(`/api/repos/${repo}/issues?state=all&limit=1`)
  expect(response.ok()).toBe(true)
  const [issue] = await response.json() as Array<{ number: number; title: string }>
  for (const shape of ["items", "item-summaries", "comments"]) await page.route(`**/api/shapes/${shape}?*`, () => undefined)
  await page.goto(`/${repo}/issues`)
  const search = page.getByRole("textbox", { name: "Search issues" })
  await search.fill(issue!.title, { timeout: 30_000 })
  const row = page.locator(`main a[href="/${repo}/issues/${issue!.number}"]`).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.locator("main.issues-screen h1").filter({ hasText: issue!.title })).toContainText(`#${issue!.number}`, { timeout: 30_000 })
  await page.goBack()
  await expect(search).toHaveValue(issue!.title)
  await expect(row).toBeVisible({ timeout: 10_000 })
})
