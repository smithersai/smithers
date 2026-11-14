// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The issues list in live mode, on the core live site (e2e/authbroker-host.vibe, `LIVE_CORE_TEST_ORIGINS`), whose
// Worker reads recorded GitHub issues: open and closed ones, with no task committed and no VIP in review. The mock's
// fixture has both (issues.spec.ts), so only here do the Tasks and VIPs filters come up empty.
import { expect, test } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_CORE_TEST_ORIGINS!)
// The list waits on the Worker's recorded read of every issue, which took 11 s under the gate's load (0016).
const listed = { timeout: 30_000 }
// That wait, then each screen re-rendering 430 rows, ran past the 30 s default on phone (0016).
test.describe.configure({ timeout: 90_000 })

test("the live list's Tasks and VIPs filters say there are none, and Issues and Closed list the recorded ones", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/?issues=1")
  const rows = page.locator(".sui-issues-row")
  await expect(rows.first()).toBeVisible(listed)
  const kind = page.getByRole("radiogroup", { name: "Kind" })
  await kind.getByRole("radio", { name: "Tasks", exact: true }).click()
  await expect(page.locator(".sui-empty-title")).toHaveText("No tasks committed")
  await expect(rows).toHaveCount(0)
  await kind.getByRole("radio", { name: "VIPs", exact: true }).click()
  await expect(page.locator(".sui-empty-title")).toHaveText("No VIPs in review")
  await expect(rows).toHaveCount(0)
  await kind.getByRole("radio", { name: "Issues", exact: true }).click()
  await expect(rows.first()).toBeVisible()
  await page.locator(".sui-issues-filter", { hasText: "Closed" }).click()
  await expect(rows.first()).toBeVisible()
  await expect(page.locator(".sui-empty-title")).toHaveCount(0)
})
