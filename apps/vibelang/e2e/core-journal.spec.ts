// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The walkthrough's demo conversation as localStorage holds it (src/web/startup.vibe decodes any schema-valid event
// list): a journal an older page or a person edited can carry moves the conversation machine refuses
// (src/core/conversation.vibe `apply`). On the next load the mock replays it (src/core/MockFactory.vibe `openRoom`); the
// page shows only what the machine accepted, and a new question is still answered and kept.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

type Stored = { type: string; seq: number; id: string; [field: string]: unknown }

const seed = (page: Page, session: string, journal: ReadonlyArray<Stored>) => page.addInitScript(({ session, journal }) => {
  if (sessionStorage.getItem("core-journal-seeded") !== null) return
  sessionStorage.setItem("core-journal-seeded", "yes")
  localStorage.setItem("vibelang:toured", "yes")
  localStorage.setItem("vibelang:tour-sound", "off")
  sessionStorage.setItem("vibelang:tour-session", session)
  sessionStorage.setItem("vibelang:tour-active", "yes")
  localStorage.setItem(`vibelang:walkthrough:demo-${session}`, JSON.stringify(journal))
}, { session, journal })

const stored = (page: Page, session: string) =>
  page.evaluate((session) => JSON.parse(localStorage.getItem(`vibelang:walkthrough:demo-${session}`) ?? "[]") as Stored[], session)

const openDemo = async (page: Page) => {
  await page.goto("/?agent=mock")
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  await page.keyboard.press("Escape")
  await expect(page.locator(".vl-glow")).toHaveCount(0)
}

// Finished replies to posts; the tour's narration (`data-walkthrough`) answers no post.
const replies = (page: Page) => page.locator(".sui-chat-message[data-role='assistant'][data-done='true']:not([data-walkthrough]):not([data-in-reply-to=''])")

const ask = async (page: Page, text: string, answered: number) => {
  const prompt = page.locator("#vl-prompt")
  await prompt.fill(text)
  await prompt.press("Enter")
  await expect(replies(page)).toHaveCount(answered, { timeout: 15_000 })
}

test("a journal's restarted reply, failure with no reason and refused run moves restore as the machine decided", async ({ page }) => {
  const session = "core-journal-moves"
  const journal: Stored[] = [
    { type: "Posted", seq: 1, id: "m1", clientId: "c-journal", name: "Guest", text: "What is a service?" },
    { type: "ReplyStarted", seq: 2, id: "m2", inReplyTo: "m1" },
    { type: "ReplyDelta", seq: 3, id: "m2", text: "Discarded words" },
    // The model call retried: what streamed is discarded and the reply streams again.
    { type: "ReplyRestarted", seq: 4, id: "m2" },
    { type: "ReplyDelta", seq: 5, id: "m2", text: "A service is" },
    // A failure with no reason is a failed answer.
    { type: "ReplyFailed", seq: 6, id: "m2", reason: "" },
    { type: "ActionRequested", seq: 7, id: "r1", flow: "check", door: "button", actor: "guest", at: 10 },
    // Refused: the same run requested again, a step with no key, an earlier attempt's late result.
    { type: "ActionRequested", seq: 8, id: "r1", flow: "check", door: "button", actor: "guest", at: 11 },
    { type: "ActionStep", seq: 9, id: "r1", key: "", name: "Nameless", attempt: 1, state: "running", at: 12 },
    { type: "ActionStep", seq: 10, id: "r1", key: "build", name: "Build", attempt: 1, state: "running", at: 5 },
    { type: "ActionStep", seq: 11, id: "r1", key: "build", name: "Build", attempt: 1, state: "passed", at: 3 },
    { type: "ActionStep", seq: 12, id: "r1", key: "test", name: "Test", attempt: 1, state: "waiting", at: 13 },
    // Cancelling the run cancels its running and waiting steps; a later settlement of the settled run is refused.
    { type: "ActionSettled", seq: 13, id: "r1", state: "cancelled", result: "", at: 20 },
    { type: "ActionSettled", seq: 14, id: "r1", state: "passed", result: "late", at: 21 },
  ]
  await seed(page, session, journal)
  await openDemo(page)
  const failed = replies(page).filter({ hasText: "A service is" })
  await expect(failed).toHaveCount(1)
  await expect(failed.locator(".vl-error")).toHaveText("Answer failed")
  await expect(page.getByText("Discarded words")).toHaveCount(0)
  await expect(page.locator(".sui-chat-message[data-role='user']")).toHaveCount(1)
  // The refused moves still took their numbers: the new post is the journal's 15th event.
  await ask(page, "What is a flow?", 2)
  const after = await stored(page, session)
  expect(after.slice(0, journal.length)).toEqual(journal)
  expect(after[journal.length]).toMatchObject({ type: "Posted", seq: journal.length + 1, text: "What is a flow?" })
})

test("a journal that skips a number restores up to the skip, and the next question is numbered after it", async ({ page }) => {
  const session = "core-journal-skip"
  const journal: Stored[] = [
    { type: "Posted", seq: 1, id: "m1", clientId: "c-skip", name: "Guest", text: "What is a service?" },
    { type: "ReplyStarted", seq: 2, id: "m2", inReplyTo: "m1" },
    { type: "ReplyDelta", seq: 3, id: "m2", text: "A service is a dependency." },
    { type: "ReplyFinished", seq: 4, id: "m2" },
    // Numbers 5 and 6 are missing: nothing from here on follows the conversation.
    { type: "Posted", seq: 7, id: "m7", clientId: "c-skipped", name: "Guest", text: "Skipped question" },
    { type: "Posted", seq: 8, id: "m8", clientId: "c-skipped-2", name: "Guest", text: "Skipped again" },
  ]
  await seed(page, session, journal)
  await openDemo(page)
  await expect(replies(page)).toHaveCount(1)
  await expect(page.getByText("Skipped question")).toHaveCount(0)
  await expect(page.getByText("Skipped again")).toHaveCount(0)
  await ask(page, "What is a flow?", 2)
  // The journal now holds the restored events, then the new question numbered right after them.
  const after = await stored(page, session)
  expect(after.slice(0, 4)).toEqual(journal.slice(0, 4))
  expect(after[4]).toMatchObject({ type: "Posted", seq: 5, text: "What is a flow?" })
  expect(after.map((event) => event.seq)).toEqual(after.map((_, index) => index + 1))
})
