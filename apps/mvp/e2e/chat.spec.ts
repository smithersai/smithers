import { questionIn } from "./messages"
import { test as deviceTest } from "./devices"
import { answerTo, expect, test } from "./fixtures"
import { home, requires } from "./target"

// Real browser, Workers, Postgres, Electric and model: no mocks. Runs locally, or against a deployment (e2e/target.ts).
// Every test opens chat and asks, which needs a Member or above.
requires("member")

test("shortcut: ⌘K opens and hides chat, and Esc and the Hide button hide it too", { annotation: { type: "summary", description: "⌘K opens and hides chat; Esc and Hide hide it too." } }, async ({ page }) => {
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  await expect(composer).toBeHidden()

  for (let round = 0; round < 3; round++) {
    await page.keyboard.press("ControlOrMeta+k")
    await expect(composer).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(composer).toBeHidden()
  }

  // The composer frame is the only box: its focused textarea draws no ring of its own.
  await page.keyboard.press("ControlOrMeta+k")
  expect(await composer.evaluate((input) => getComputedStyle(input).boxShadow)).toBe("none")
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: /Chat/ }).click()
  await expect(composer).toBeFocused()
  await page.keyboard.press("ControlOrMeta+k")
  await expect(composer).toBeHidden()

  await page.keyboard.press("ControlOrMeta+k")
  await page.getByRole("button", { name: /Hide/ }).click()
  await expect(composer).toBeHidden()
})

test("ask: a user asks Smithers and gets a streamed answer", { annotation: { type: "summary", description: "A question gets a streamed answer." } }, async ({ page }) => {
  requires("liveModel")
  await page.goto(home())
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press("ControlOrMeta+k")
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  // The conversation is shared and persists, so each run asks for its own word.
  const word = `pong-${Date.now()}`
  await composer.fill(`Reply with exactly the word: ${word}`)
  await composer.press("Enter")

  const conversation = page.getByRole("region", { name: "Conversation", exact: true })
  await expect(questionIn(conversation, `Reply with exactly the word: ${word}`)).toBeVisible()
  await expect(answerTo(conversation, `Reply with exactly the word: ${word}`)).toContainText(word, { timeout: 60_000 })
})

test("reload mid-answer: the browser's agent resumes the answer after the reload and completes it, and the composer works", { annotation: { type: "summary", description: "A reload mid-answer loses nothing: the answer finishes and the composer still works." } }, async ({ page }) => {
  requires("liveModel")
  await page.goto(home())
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press("ControlOrMeta+k")
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  const word = `count-${Date.now()}`
  const question = `Write ${word} on the first line, then count from 1 to 120 in words, one number per line, then write end-${word} on the last line.`
  const taken = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/questions")
  await composer.fill(question)
  await composer.press("Enter")

  // ChatApi took the question (202), so this tab's agent is answering it. The page reloads while the answer is unfinished;
  // the reloaded page's engine resumes the run from its journal.
  const conversation = page.getByRole("region", { name: "Conversation", exact: true })
  const answer = answerTo(conversation, question)
  expect((await taken).status()).toBe(202)
  // Unfinished: "Smithers is answering", or text still streaming.
  await expect(answer.locator('[role="status"], [data-slot="message-response"][data-streaming="true"]')).toHaveCount(1, { timeout: 60_000 })
  await page.reload()

  // After the reload the same answer finishes: its last line arrives and it stops streaming.
  await expect(answer).toContainText(`end-${word}`, { timeout: 60_000 })
  await expect(answer).toContainText(word)
  await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
  await expect(questionIn(conversation, question)).toHaveCount(1)

  // The composer works after the reload: it opens, and the next question gets its answer.
  const next = `after-${Date.now()}`
  await page.keyboard.press("ControlOrMeta+k")
  await expect(composer).toBeFocused()
  await composer.fill(`Reply with exactly the word: ${next}`)
  await composer.press("Enter")
  await expect(answerTo(conversation, `Reply with exactly the word: ${next}`)).toContainText(next, { timeout: 60_000 })
})

// What a person sees, not just what is in the page: `toBeInViewport`, where `toBeVisible` passes for an element
// scrolled out of sight. The conversation keeps its newest message in view, as the transcript's bottom anchor intends.
deviceTest("in view: opening chat shows the newest message and the Chat button, and a new question and its answer stay in view", { annotation: { type: "summary", description: "The newest message and its answer stay in view." } }, async ({ devices }) => {
  requires("personalModel", "ownConversation", "liveModel")
  const [a] = await devices.open("A")
  const page = a.page
  // A fresh branch can have no messages. Establish this test's own history, then open it again: opening must show
  // the newest answer without scrolling, whether the conversation is /app's or a branch's.
  const previous = `Reply with exactly the word: previous-${devices.word}`
  await a.askAndWaitTaken(previous)
  await a.expectAnswered(previous, `previous-${devices.word}`)
  await a.reload()
  const chatButton = page.getByRole("button", { name: /Chat/ })
  await expect(chatButton).toBeVisible({ timeout: 30_000 })
  const conversation = page.getByRole("region", { name: "Conversation", exact: true })
  await expect(conversation.locator(".sui-chat-message").last(), "the newest message shows without scrolling").toBeInViewport({ timeout: 30_000 })
  await expect(chatButton, "the Chat button shows without scrolling").toBeInViewport()

  await chatButton.click()
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  const word = `view-${Date.now()}`
  const question = `Reply with exactly the word: ${word}`
  await composer.fill(question)
  await composer.press("Enter")
  await expect(a.question(question), "the question shows where the person looks").toBeInViewport()
  await expect(answerTo(conversation, question)).toContainText(word, { timeout: 60_000 })
  await expect(answerTo(conversation, question), "its answer shows without scrolling").toBeInViewport()
  await expect(composer).toBeInViewport()
})

// A message is one element from the moment it shows: a question syncing and its answer settling change it in place, so
// its fade-in plays once, not again at each change of status.
test("steady: a question and its answer keep their elements as the question syncs and the answer settles", { annotation: { type: "summary", description: "A question and its answer don't flicker as they sync and settle." } }, async ({ page }) => {
  requires("liveModel")
  await page.goto(home())
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press("ControlOrMeta+k")
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  const conversation = page.getByRole("region", { name: "Conversation", exact: true })
  const word = `steady-${Date.now()}`
  const question = `Reply with exactly the word: ${word}`
  await composer.fill(question)
  await composer.press("Enter")

  // The question as it first shows, before Postgres has it, and the answer as it first shows, before it settles.
  const asked = await questionIn(conversation, question).first().elementHandle()
  const answer = answerTo(conversation, question)
  await expect(answer).toHaveAttribute("data-state", "streaming", { timeout: 60_000 })
  const streaming = await answer.elementHandle()
  await expect(answer).toContainText(word, { timeout: 60_000 })
  await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false", { timeout: 60_000 })

  expect(await asked!.evaluate((element) => element.isConnected), "the question's element survived syncing").toBe(true)
  expect(await streaming!.evaluate((element) => element.isConnected), "the answer's element survived settling").toBe(true)
})
