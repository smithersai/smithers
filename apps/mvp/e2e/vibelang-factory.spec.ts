import type { Page } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { requires } from "./target"
import { as, REPO, requiresMaintainer, type Who } from "./vibelang"

// VibeLang's live factory on Smithers (decision 0128, docs/features/factory.md): VibeLang's collector pushes its real
// status to the deployment every minute, and a fresh browser, signed out or signed in, opens the Factory tab of
// smithersai/vibelang and sees every view drawn from it. It only reads: it never pushes, deletes or answers, so the
// collector's documents stay as the collector left them (factory-plugin.spec.ts pushes its own sample instead).
requires("vibelangFeed")

const FACTORY = `${REPO}/-/factory`

/** How old the newest status may be: the collector pushes every minute, so a quarter of an hour is a stalled feed. */
const FRESH_MS = 15 * 60_000

/** Each view anyone may open, by path, and the section its live data draws in. */
const VIEWS = [
  { path: "", title: "Now", section: "Scoreboard" },
  { path: "failures", title: "Failures", section: "Failures" },
  { path: "reviews", title: "Spec reviews", section: "Rounds" },
  { path: "implementation", title: "Implementation", section: "Pending constructs" },
  { path: "commits", title: "Commits", section: "Commits" },
  { path: "agents", title: "Agents", section: "Lanes" },
  { path: "media", title: "Media", section: "Media" },
  { path: "docs", title: "Docs", section: "Docs" },
  { path: "queue", title: "Queue", section: "Merge queue" },
] as const

/** Opens view `path` with a full page load, as a fresh browser does, and waits for its live status. */
const open = (page: Page, view: (typeof VIEWS)[number]) =>
  step(`${view.title}: drawn from the collector's live status`, async () => {
    await page.goto(view.path === "" ? FACTORY : `${FACTORY}/${view.path}`)
    const factory = page.locator(".factory")
    await expect(factory.getByRole("navigation", { name: "Factory" }).getByRole("link", { name: view.title, exact: true }))
      .toHaveAttribute("aria-current", "page", { timeout: 60_000 })
    const section = factory.getByRole("region", { name: view.section, exact: true })
    await expect(section, `${view.title} draws ${view.section} from the feed, not "No feed yet"`).toBeVisible({ timeout: 60_000 })
    await expect(factory.getByText("No feed yet", { exact: true })).toHaveCount(0)
    // Every section but Docs, one button, lists the collector's rows.
    if (view.path !== "docs") {
      await expect(section.locator("tbody tr, article, [role='row']").first()).toBeVisible()
    }
    const updated = factory.getByLabel("Updated")
    const at = Date.parse((await updated.getAttribute("datetime")) ?? "")
    expect(Number.isFinite(at), "the view says when the status was pushed").toBe(true)
    expect(Date.now() - at, "the status is the collector's latest, not a stale snapshot").toBeLessThan(FRESH_MS)
  })

for (const who of ["visitor", "contributor"] as const satisfies ReadonlyArray<Who>) {
  test(
    `factory, live: a fresh ${who}'s browser opens every view of VibeLang's Factory tab with the collector's status`,
    { annotation: { type: "summary", description: `A fresh ${who === "visitor" ? "signed-out " : ""}browser sees VibeLang's live factory in every view.` } },
    async ({ page }) => {
      test.setTimeout(300_000)
      await as(page, who)
      await step("The repository's header has the Factory tab", async () => {
        await page.goto(REPO)
        const tab = page.locator('header[aria-label="Repository"]').getByRole("link", { name: "Factory", exact: true })
        await expect(tab).toHaveAttribute("href", FACTORY, { timeout: 60_000 })
      })
      for (const view of VIEWS) await open(page, view)
      await step("Docs opens VibeLang's docs", async () => {
        await page.locator(".factory").getByRole("navigation", { name: "Factory" }).getByRole("link", { name: "Docs", exact: true }).click()
        await page.locator(".factory").getByRole("button", { name: "Open docs" }).click()
        await expect(page).toHaveURL((url) => url.pathname === `${REPO}/docs`)
      })
    },
  )
}

test(
  "factory, live: For you shows a maintainer what waits on them",
  { annotation: { type: "summary", description: "A maintainer of VibeLang opens For you and sees the decisions waiting." } },
  async ({ page }) => {
    await requiresMaintainer(page)
    test.setTimeout(120_000)
    await page.goto(`${FACTORY}/for-you`)
    await expect(page.locator(".factory").getByRole("region", { name: "Waiting" })).toBeVisible({ timeout: 60_000 })
  },
)
