// The deploy smoke's cold path (docs/features/issues.md#first-paint): a person back after their role row expired. This is
// the visit the first paint exists for, and a failure here shipped once: the paint's deadline interrupted the role read,
// so the same page's /role and /refs answered 503 and the first paint never came.
//
// It ages the person's role row first (ops/role-age/expire.ts), so it never waits five minutes, then opens the list on
// a new device: the first paint's read answers within its deadline, the page's own /role and /refs never answer 503,
// and the next visit finds the row fresh and paints. A role read that can't age the row fails the test: a smoke that
// can't make the row stale proves nothing. Part of the deploy smoke (docs/infrastructure.md#the-deploy-smoke):
//
//   cd apps/mvp && ~/vault-ws-deployer/bin/mvp-prod-env node ops/deploy-smoke/run.ts
import { execFileSync } from "node:child_process"
import type { Page, Response } from "@playwright/test"
import { FIRST_PAINT_DEADLINE_MS } from "../worker/github/FirstPaint"
import { expect, test } from "./fixtures"
import { me, requires } from "./target"
import { expectServerError } from "./watch"

requires("trackingRepository")

const repo = process.env.E2E_TRACKING_REPOSITORY ?? ""
/** The route's deadline, and a request's way there and back on a loaded runner. */
const ANSWER_WITHIN_MS = FIRST_PAINT_DEADLINE_MS + 1_500

const ageRole = async () => {
  const project = process.env.E2E_ROLE_EXPIRE_PROJECT
  const args = ["ops/role-age/expire.ts", "--repo", repo, "--person", me().personId, ...(project === undefined ? [] : ["--project", project])]
  // A read's claim or a cooldown holds the row for seconds: it is aged once they end, never out from under them.
  await expect.poll(() => (JSON.parse(execFileSync("node", args, { encoding: "utf8" })) as { readonly state: string }).state, { timeout: 45_000, intervals: [2_000] })
    .not.toBe("busy")
}

/** Each answer the page gets to `suffix` on this repository. */
const answersTo = (page: Page, suffix: string) => {
  const statuses: Array<number> = []
  page.on("response", (response: Response) => {
    if (new URL(response.url()).pathname === `/api/repos/${repo}/${suffix}`) statuses.push(response.status())
  })
  return statuses
}

const paintRead = (page: Page) =>
  page.evaluate(() => {
    const read = (performance.getEntriesByType("resource") as Array<PerformanceResourceTiming>).find((entry) => entry.name.includes("/first-paint"))
    return read === undefined ? undefined : read.responseEnd - read.startTime
  })

// The About read of a private repository answers 404 for anyone: it reads what GitHub says publicly. WebKit reports a
// worker's failed request on the page's console, and the engine worker makes this one; Chromium doesn't.
expectServerError(404, `/api/repos/${repo}/about`)

test("a role row past its life: the first paint's read answers in time and paints, /role and /refs never answer 503, and the next visit paints", async ({ page, browser }) => {
  test.setTimeout(120_000)
  await ageRole()
  const roles = answersTo(page, "role")
  const refs = answersTo(page, "refs")
  const paints = answersTo(page, "first-paint")
  await page.goto(`/${repo}/issues`)
  await expect.poll(() => paintRead(page), { timeout: 15_000 }).toBeDefined()
  expect(await paintRead(page)).toBeLessThan(ANSWER_WITHIN_MS)
  // The stale visit itself paints: this is the visit the first paint exists for. A 204 here says GitHub took longer than
  // the route's deadline, or the role read failed.
  expect(paints).toEqual([200])
  await expect(page.locator("#first-paint li").first()).toBeVisible({ timeout: 5_000 })
  // The app's own page comes, with its controls, whether or not GitHub answered in time for a paint.
  await page.getByRole("textbox", { name: "Search issues" }).click({ timeout: 30_000 })
  await expect.poll(() => roles.length, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect.poll(() => refs.length, { timeout: 30_000 }).toBeGreaterThan(0)
  expect(roles.filter((status) => status >= 500)).toEqual([])
  expect(refs.filter((status) => status >= 500)).toEqual([])
  expect(roles.at(-1)).toBe(200)

  // The row is fresh now, renewed by whichever read got there: a new device paints.
  const next = await browser.newContext({ storageState: await page.context().storageState() })
  const second = await next.newPage()
  await second.goto(new URL(`/${repo}/issues`, page.url()).toString())
  await expect(second.locator("#first-paint li").first()).toBeVisible({ timeout: 15_000 })
  await next.close()
})
