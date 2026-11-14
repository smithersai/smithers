// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The history page in live mode (src/history/LiveMythical.vibe) on the live site whose API Worker runs the production
// History object in workerd (e2e/authbroker-host.vibe, `LIVE_CORE_TEST_ORIGINS`), signed in with the fixture session.
// Each browser project has its own Worker, so the people and commits here are that project's.
import { expect, test, type Page } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_CORE_TEST_ORIGINS!)

/** A fixture session for person `id` (core-live.spec.ts); the browser's cookie unless `browser` is false. */
async function signIn(page: Page, origin: string, id: string, login: string, browser = true) {
  const issued = await (await page.request.get(`${origin}/__fixture/issue?id=${id}&login=${login}`)).json() as { cookie: string }
  const value = issued.cookie.slice(issued.cookie.indexOf("=") + 1)
  if (browser) await page.context().addCookies([{ name: "vibelang-session", value, url: origin, httpOnly: true, sameSite: "Lax" }])
  return `vibelang-session=${value}`
}

async function open(page: Page, origin: string, hash = "") {
  await page.goto(origin + "/history" + hash)
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30_000 })
}

test("a maintainer plans, starts, notes and approves a commit in the live history", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const title = `test(history): a live plan on ${info.project.name}`
  await signIn(page, origin, "1", "will")
  await open(page, origin)
  await page.getByRole("button", { name: "Plan work" }).click()
  const dialog = page.getByRole("dialog", { name: "Plan work" })
  await dialog.getByLabel("Commit").fill(title)
  await dialog.getByLabel("Epic").selectOption({ label: "The compiler" })
  await dialog.getByRole("button", { name: "Plan work" }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("planned")
  await page.getByLabel("Lane").fill("lane-live")
  await page.getByRole("button", { name: "Start" }).click()
  await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("working")
  await page.getByLabel("Section").selectOption("tried")
  await page.getByLabel("Note", { exact: true }).fill("A live note.")
  await page.getByRole("button", { name: "Add note" }).click()
  await expect(page.getByText("A live note.")).toBeVisible()
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("approved")
  // The commit's epic page and a filtered search, each one read of the Worker's History object.
  await page.getByRole("link", { name: "The compiler", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "The compiler" })).toBeVisible()
  await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link").first()).toBeVisible()
  await page.getByRole("link", { name: "History", exact: true }).click()
  await page.getByLabel("Filter commits").fill("live plan")
  await expect(page.getByRole("list", { name: "Matching commits" }).getByRole("link")).toContainText([title])
})

test("the live history refuses a plan without a title in the sequencer's words", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await signIn(page, origin, "1", "will")
  await open(page, origin)
  await page.getByRole("button", { name: "Plan work" }).click()
  const dialog = page.getByRole("dialog", { name: "Plan work" })
  await dialog.getByLabel("Task").fill("issue 7")
  await dialog.getByRole("button", { name: "Plan work" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("Needs a title.")
})

test("a signed-out visitor reads the live history and may not plan", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await open(page, origin)
  await expect(page.getByRole("button", { name: "Plan work" })).toHaveCount(0)
})

test("a role granted while the live history is open lets that person plan", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const maintainer = await signIn(page, origin, "1", "will", false)
  await signIn(page, origin, "71", "person-71")
  await open(page, origin)
  await expect(page.getByRole("button", { name: "Plan work" })).toHaveCount(0)
  const grant = (id: string) => page.request.post(`${origin}/api/roles`, { headers: { cookie: maintainer, origin }, data: { id, role: "contributor" } })
  // Another person's grant first: the page's role stream skips it (historyStartup.vibe `grantsMe`).
  expect((await grant("72")).status()).toBe(200)
  expect((await grant("71")).status()).toBe(200)
  await expect(page.getByRole("button", { name: "Plan work" })).toBeVisible()
})

test("Export in the live history, with no repository to export to, says why", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await signIn(page, origin, "1", "will")
  await open(page, origin)
  await page.getByRole("button", { name: "Export", exact: true }).click()
  // The deployment names no repository, so its exporter is `off` (worker/HistoryExport.vibe) and the History object
  // refuses `unsupported`, which the page words "Export is off." (flowMachine.vibe `historyRefusal`).
  await expect(page.getByRole("alert").filter({ hasText: "Export is off." })).toBeVisible()
})
