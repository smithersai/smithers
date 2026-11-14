// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The live history page (src/history/LiveMythical.vibe) on the core live site (e2e/authbroker-host.vibe,
// `LIVE_CORE_TEST_ORIGINS`) with a fault in its own HTTP (e2e/history-runtime `?http=`,
// test/support/FaultyHistoryHttp.vibe): the History object's request answered with a status it never sends, once.
import { expect, test, type Page } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_CORE_TEST_ORIGINS!)
const UNREACHABLE = "The history can't be reached."

/** Signs in fixture maintainer 1 (live-history.spec.ts) and opens the live history page with `fault` in its HTTP. */
async function open(page: Page, origin: string, fault: string) {
  const issued = await (await page.request.get(`${origin}/__fixture/issue?id=1&login=will`)).json() as { cookie: string }
  const value = issued.cookie.slice(issued.cookie.indexOf("=") + 1)
  await page.context().addCookies([{ name: "vibelang-session", value, url: origin, httpOnly: true, sameSite: "Lax" }])
  await page.goto(`${origin}/e2e/history-runtime/index.html?http=${fault}`)
}

test.describe("the live history page when the History object answers out of protocol", () => {
  test("an outline answered 503 says so, and Retry loads the history", async ({ page }, info) => {
    await open(page, origins[info.project.name]!, "outline")
    const alert = page.getByRole("alert")
    await expect(alert).toContainText("Couldn't load the history.", { timeout: 30_000 })
    await alert.getByRole("button", { name: "Retry" }).click()
    await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("alert")).toHaveCount(0)
  })

  test("an events stream answered 503 offers Reconnect", async ({ page }, info) => {
    await open(page, origins[info.project.name]!, "events")
    await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("status")).toContainText("Disconnected")
    await page.getByRole("button", { name: "Reconnect" }).click()
    await expect(page.getByRole("button", { name: "Reconnect" })).toHaveCount(0)
  })

  test("a write answered 500 says so, and the next one is written", async ({ page }, info) => {
    const title = `fix(history): a 500 on ${info.project.name}`
    await open(page, origins[info.project.name]!, "write")
    await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Commit").fill(title)
    await dialog.getByLabel("Epic").selectOption({ label: "The compiler" })
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(dialog.getByRole("alert")).toHaveText(UNREACHABLE)
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  })
})
