// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// A walkthrough the page left running: localStorage journals its tour conversation (src/web/startup.vibe). On the next
// load the mock restores the conversation and runs the tour again from the step it showed (src/core/flows.vibe `walk`),
// with what is left of that step's reading time (src/core/conversation.vibe `holdRemaining`): none once the time ran
// out, and all of it when the step's clock reads later than the page's.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

type Stored = { type: string; seq: number; id: string; [field: string]: unknown }

const seed = (page: Page, session: string, journal: ReadonlyArray<Stored>) => page.addInitScript(({ session, journal }) => {
  if (sessionStorage.getItem("core-tour-journal-seeded") !== null) return
  sessionStorage.setItem("core-tour-journal-seeded", "yes")
  localStorage.setItem("vibelang:toured", "yes")
  localStorage.setItem("vibelang:tour-sound", "off")
  sessionStorage.setItem("vibelang:tour-session", session)
  sessionStorage.setItem("vibelang:tour-active", "yes")
  localStorage.setItem(`vibelang:walkthrough:tour-${session}`, JSON.stringify(journal))
}, { session, journal })

const stored = (page: Page, session: string) =>
  page.evaluate((session) => JSON.parse(localStorage.getItem(`vibelang:walkthrough:tour-${session}`) ?? "[]") as Stored[], session)

// The issues step: its reading time is 15 seconds.
const issuesStep = { type: "WalkthroughDriven", id: "t1", step: 3, target: "issues", duration: 15_000 }

test("a tour restored after its step's reading time ran out moves on to the next step", async ({ page }) => {
  await seed(page, "core-tour-elapsed", [
    { type: "TourStarted", seq: 1, id: "t1" },
    { ...issuesStep, seq: 2, at: 1_000 },
  ])
  await page.goto("/?agent=mock")
  const bar = page.getByRole("region", { name: "Walkthrough" })
  // Step 3 would hold for 15 seconds; none of it is left, so the tour shows step 4 well before that.
  await expect(bar).toHaveAttribute("data-step", "4", { timeout: 10_000 })
})

test("a restored step whose clock reads later keeps its reading time, and Escape ends the tour after an earlier one", async ({ page }) => {
  const session = "core-tour-ahead"
  const journal: Stored[] = [
    { type: "TourStarted", seq: 1, id: "t0" },
    { type: "TourEnded", seq: 2, id: "t0" },
    { type: "TourStarted", seq: 3, id: "t1" },
    // 2100-01-01: no time has passed on this step by the page's clock.
    { ...issuesStep, seq: 4, at: 4_102_444_800_000 },
  ]
  await seed(page, session, journal)
  await page.goto("/?agent=mock")
  const bar = page.getByRole("region", { name: "Walkthrough" })
  await expect(bar).toHaveAttribute("data-step", "3", { timeout: 15_000 })
  // The whole 15 seconds remain: after 8 the tour still shows step 3.
  await page.waitForTimeout(8_000)
  await expect(bar).toHaveAttribute("data-step", "3")
  await page.keyboard.press("Escape")
  await expect(bar).toHaveCount(0)
  // The second tour ended; the first stays as it was.
  await expect.poll(async () => (await stored(page, session)).slice(journal.length).map((event) => [event.type, event.id])).toEqual([["TourEnded", "t1"]])
  expect((await stored(page, session)).slice(0, journal.length)).toEqual(journal)
})
