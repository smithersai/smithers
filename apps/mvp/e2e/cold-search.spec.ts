import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("trackingRepository")
const repo = process.env.E2E_TRACKING_REPOSITORY ?? ""
// The issues-only fixture has no Code Storage mirror or public repository metadata.
expectServerError(404, `/api/repos/${repo}/about`)
expectServerError(404, `/api/repos/${repo}/refs`)

test("a cold search starts before the store and publishes through the normal gated list", async ({ page, request }) => {
  const response = await request.get(`/api/repos/${repo}/issues?state=all&limit=1`)
  expect(response.ok()).toBe(true)
  const [issue] = await response.json() as Array<{ number: number }>
  await page.addInitScript(() => {
    const states: string[] = []
    Object.assign(window, { coldSearchLoading: states })
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('[data-list-sync], [data-slot="skeleton"], [aria-busy="true"], [role="progressbar"]')) {
        if (node.getClientRects().length > 0) states.push(node.getAttribute("data-slot") ?? node.getAttribute("role") ?? "loading")
      }
    }).observe(document, { childList: true, subtree: true, attributes: true })
  })
  // Keep the real role request pending until the early gated paint, then let its authorized answer settle the route.
  // A fixed delay races the normal view taking over and can miss a correct transient paint.
  const role = Promise.withResolvers<void>()
  await page.route(`**/api/repos/${repo}/role`, async route => {
    await role.promise
    await route.continue()
  })
  const timing = () => page.evaluate(() => {
    const read = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find(entry => {
      const url = new URL(entry.name)
      return url.pathname.endsWith("/issues") && url.searchParams.has("q")
    })
    return { request: read?.startTime, store: performance.getEntriesByName("smithers.boot.store")[0]?.startTime, marks: performance.getEntriesByType("mark").filter(m => m.name.startsWith("smithers.")).map(m => ({ name: m.name, at: m.startTime })) }
  })
  try {
    await page.goto(`/${repo}/issues`)
    const input = page.locator('#first-paint input[aria-label="Search issues"]')
    await input.fill(`#${issue!.number}`)
    expect(await page.evaluate(() => performance.getEntriesByName("smithers.boot.services").length)).toBe(0)
    await expect(page.locator(`#first-paint a[href="/${repo}/issues/${issue!.number}"]`).first()).toBeVisible({ timeout: 30_000 })
  } finally {
    // Preserve the shell's end reason and boot stages even when the early-paint assertion fails.
    const before = await timing().catch(() => ({ unavailable: true }))
    test.info().annotations.push({ type: "cold-search-before-handover", description: JSON.stringify(before) })
    role.resolve()
  }
  await expect(page.locator(`main.issues-screen a[href="/${repo}/issues/${issue!.number}"]`).first()).toBeVisible({ timeout: 30_000 })
  const times = await timing()
  test.info().annotations.push({ type: "cold-search", description: JSON.stringify(times) })
  expect(await page.evaluate(() => (window as unknown as { coldSearchLoading: string[] }).coldSearchLoading)).toEqual([])
  expect(times.request).toBeDefined()
  expect(times.store).toBeDefined()
  expect(times.request!).toBeLessThan(times.store!)
  await expect(page.getByRole("textbox", { name: "Search issues" })).toHaveValue(`#${issue!.number}`)
})
