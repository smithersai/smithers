// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The Actions pane in live mode (src/actions/LiveActions.vibe) on the live site whose API Worker runs the production
// actions routes and durable engine in workerd (e2e/authbroker-host.vibe, `LIVE_CORE_TEST_ORIGINS`).
import { expect, test, type Page } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_CORE_TEST_ORIGINS!)

/** A fixture session for person `id`, as the browser's cookie (core-live.spec.ts). */
async function signIn(page: Page, origin: string, id: string, login: string) {
  const issued = await (await page.request.get(`${origin}/__fixture/issue?id=${id}&login=${login}`)).json() as { cookie: string }
  const value = issued.cookie.slice(issued.cookie.indexOf("=") + 1)
  await page.context().addCookies([{ name: "vibelang-session", value, url: origin, httpOnly: true, sameSite: "Lax" }])
}

test("a maintainer runs Tour from the live Actions pane, follows its trace, cancels it and runs it again", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await signIn(page, origin, "1", "will")
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/")
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByRole("textbox", { name: "Message" }).fill("hello")
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  const pane = page.getByRole("region", { name: "Actions", exact: true })
  await pane.getByRole("button", { name: "Tour", exact: true }).click()
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  const card = page.getByRole("button", { name: /Open Tour run/ }).first()
  // The card waits on the Worker's durable engine answering the start and the page's read of it. With three projects'
  // Workers starting at once it took more than expect's 5 s default (0016, session 38).
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()
  await expect(pane.getByLabel("Logs", { exact: true })).toContainText(/start|guide/)
  await pane.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(pane.getByText("Cancelled", { exact: true }).first()).toBeVisible()
  // A run that ended offers Re-run, which starts a new run of the same flow (POST /runs/<id>/rerun).
  await pane.getByRole("button", { name: "Re-run", exact: true }).click()
  await expect(page.getByRole("button", { name: /Open Tour run/ })).toHaveCount(2)
  await expect(pane.getByText("Running", { exact: true })).toBeVisible()
  await pane.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(pane.getByText("Running", { exact: true })).toHaveCount(0)
})
