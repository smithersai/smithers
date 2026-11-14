// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The specification screen in live mode, on the core live site (e2e/authbroker-host.vibe, `LIVE_CORE_TEST_ORIGINS`),
// whose Worker has saved no specification: it answers the empty one (worker/Issues.vibe, `emptySpecification`), so
// the screen reads revision 0, in review, with no reviewer's answer. issues.spec.ts covers the mock's accepted one.
import { expect, test } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_CORE_TEST_ORIGINS!)
// The list waits on the Worker's recorded read of every issue, which took 11 s under the gate's load (0016).
const listed = { timeout: 30_000 }
// That wait, then each screen re-rendering 430 rows, ran past the 30 s default on phone (0016).
test.describe.configure({ timeout: 90_000 })

test("a live specification with no revision reads In review, with no reviewer's verdict, grade or revision", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/?issues=1")
  await expect(page.locator(".sui-issues-row").first()).toBeVisible(listed)
  await page.getByRole("button", { name: "Specification", exact: true }).click()
  await expect(page.getByText("Revision 0", { exact: true })).toBeVisible()
  await expect(page.getByRole("status", { name: "Specification gate" })).toHaveText("In review")
  const rows = page.getByRole("table", { name: "Specification reviews" }).locator("tbody tr")
  await expect(rows).toHaveCount(4)
  for (const row of await rows.all()) {
    await expect(row.locator("td").nth(1)).toHaveText("—")
    await expect(row.locator("td").nth(2)).toHaveText("—")
    await expect(row.locator("td").nth(3)).toHaveText("—")
    await expect(row.getByRole("link")).toHaveCount(0)
  }
  // A visitor may not request a review, and an unaccepted specification has no self-consistency suites.
  await expect(page.getByRole("button", { name: "Request review" })).toHaveCount(0)
  await expect(page.getByText("Self-consistency", { exact: true })).toHaveCount(0)
})
