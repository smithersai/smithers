// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// A page closed while the agent answered in the walkthrough's demo conversation. The page journals that conversation in
// localStorage (src/web/startup.vibe); the journal below is what it holds when the page closes mid-reply: the post, the
// reply's start and its first words. On the next load the tour resumes, the mock restores the conversation, and the reply
// no execution can finish any more reads failed (src/core/MockFactory.vibe `openRoom`), so a new question is answered.
import { expect, test } from "./coverage"

const SESSION = "core-restore"

test.beforeEach(async ({ page }) => {
  await page.addInitScript((session) => {
    if (sessionStorage.getItem("core-restore-seeded") !== null) return
    sessionStorage.setItem("core-restore-seeded", "yes")
    localStorage.setItem("vibelang:toured", "yes")
    localStorage.setItem("vibelang:tour-sound", "off")
    sessionStorage.setItem("vibelang:tour-session", session)
    sessionStorage.setItem("vibelang:tour-active", "yes")
    localStorage.setItem(`vibelang:walkthrough:demo-${session}`, JSON.stringify([
      { type: "Posted", seq: 1, id: "m1", clientId: "c-restore", name: "Guest", text: "What is a service?" },
      { type: "ReplyStarted", seq: 2, id: "m2", inReplyTo: "m1" },
      { type: "ReplyDelta", seq: 3, id: "m2", text: "A service is" },
    ]))
  }, SESSION)
})

test("a reply the page closed on reads failed after the reload, and the next question is answered", async ({ page }) => {
  await page.goto("/?agent=mock")
  await expect(page.locator(".vl-theatre-bar")).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  await page.keyboard.press("Escape")
  await expect(page.locator(".vl-glow")).toHaveCount(0)
  const failed = page.locator(".sui-chat-message[data-role='assistant']").filter({ hasText: "A service is" })
  await expect(failed.locator(".vl-error")).toHaveText("The agent failed. Try again.")
  const asked = page.locator(".sui-chat-message[data-role='user']")
  await expect(asked).toHaveCount(1)
  await expect(asked).toContainText("What is a service?")
  const prompt = page.locator("#vl-prompt")
  await prompt.fill("What is a flow?")
  await prompt.press("Enter")
  // The answer to the new post: an agent entry that replies to a post other than the failed reply's.
  const answer = page.locator(".sui-chat-message[data-role='assistant'][data-done='true']:not([data-in-reply-to='m1']):not([data-in-reply-to=''])")
  await expect(answer).toHaveCount(1, { timeout: 15_000 })
  await expect(answer).toContainText("VibeLang")
  await expect(answer).not.toContainText("The agent failed")
  await expect(failed).toHaveCount(1)
  // The restored journal now ends with the failure, so a second reload shows the same conversation.
  const journal = await page.evaluate((session) => JSON.parse(localStorage.getItem(`vibelang:walkthrough:demo-${session}`) ?? "[]") as Array<{ type: string; id: string }>, SESSION)
  expect(journal.slice(0, 4).map((event) => event.type)).toEqual(["Posted", "ReplyStarted", "ReplyDelta", "ReplyFailed"])
})
