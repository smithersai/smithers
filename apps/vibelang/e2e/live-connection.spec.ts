// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The GitHub connection controls of the issues screen in live mode, on the core live site whose API Worker answers
// issue reads from recorded GitHub (e2e/authbroker-host.vibe, `LIVE_CORE_TEST_ORIGINS`). The Worker reports
// `connected` from the principal's GitHub connection; a fixture session has none, so a signed-in person is offered
// Connect and a signed-out visitor is offered neither control. live-issues.spec.ts covers Disconnect.
import { expect, test, type Page } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_CORE_TEST_ORIGINS!)
// The list waits on the Worker's recorded read of every issue, which took 11 s under the gate's load (0016).
const listed = { timeout: 30_000 }

async function openIssues(page: Page, origin: string) {
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/?issues=1")
  await expect(page.locator(".sui-issues-row").first()).toBeVisible(listed)
}

test("a signed-in person with no GitHub connection is offered Connect GitHub on the list and on an issue", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const issued = await (await page.request.get(`${origin}/__fixture/issue?id=2&login=ada`)).json() as { cookie: string }
  await page.context().addCookies([{ name: "vibelang-session", value: issued.cookie.slice(issued.cookie.indexOf("=") + 1), url: origin, httpOnly: true, sameSite: "Lax" }])
  await openIssues(page, origin)
  const connect = page.getByRole("button", { name: "Connect GitHub", exact: true })
  await expect(connect).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0)
  // Connect posts to the connection route, which starts consent on smithers (authbroker.spec.ts).
  await expect(connect.locator("xpath=ancestor::form")).toHaveAttribute("action", "/api/auth/connect")
  await expect(connect.locator("xpath=ancestor::form")).toHaveAttribute("method", "post")

  const first = page.locator(".sui-issues-row").first().locator(".sui-issues-title")
  const title = (await first.innerText()).trim()
  await first.click()
  await expect(page.getByRole("heading", { name: title })).toBeVisible()
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toHaveCount(1)
  // Writes need the connection: no Split, Link or Commit until the person connects.
  for (const name of ["Split", "Link", "Commit"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0)
})

test("a signed-out visitor reads the live issues with neither Connect GitHub nor Disconnect", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await openIssues(page, origin)
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0)
})
