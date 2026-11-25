import type { Locator, Page } from "@playwright/test"
import { attachToOpenConversation as attach } from "./attach"
import { questionIn } from "./messages"
import { test as deviceTest } from "./devices"
import { answerTo, expect, test } from "./fixtures"
import { appHome, requires } from "./target"

// Real browser, Worker, Postgres and Electric. A separate MCP client answers through the attached session.
// Every test opens chat and asks, which needs a Member or above.
requires("member")

const respond = async (
  agent: Awaited<ReturnType<typeof attach>>,
  conversation: Locator,
  question: string,
  text: string,
) => {
  const row = questionIn(conversation, question).first()
  await expect(row).toHaveAttribute("data-state", "done", { timeout: 60_000 })
  const id = await row.getAttribute("data-id")
  if (id === null) throw new Error("The accepted question has no id")
  await agent.respond(id, text)
}

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

test("ask: an attached agent answers a question", { annotation: { type: "summary", description: "A question gets an answer over MCP." } }, async ({ page }) => {
  requires("ownConversation")
  await page.goto(appHome())
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  const agent = await attach(page)
  try {
    await page.keyboard.press("ControlOrMeta+k")
    const composer = page.getByRole("textbox", { name: "Message Smithers" })
    const word = `pong-${Date.now()}`
    const question = `Reply with exactly the word: ${word}`
    await composer.fill(question)
    await composer.press("Enter")
    const conversation = page.getByRole("region", { name: "Conversation", exact: true })
    await respond(agent, conversation, question, word)
    await expect(answerTo(conversation, question)).toContainText(word, { timeout: 60_000 })
  } finally {
    await agent.revoke()
  }
})

test("reload while waiting: the attached agent can still answer and the composer works", { annotation: { type: "summary", description: "An attached agent can answer after the person reloads." } }, async ({ page }) => {
  requires("ownConversation")
  await page.goto(appHome())
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  const agent = await attach(page)
  try {
    await page.keyboard.press("ControlOrMeta+k")
    const composer = page.getByRole("textbox", { name: "Message Smithers" })
    const word = `after-reload-${Date.now()}`
    const question = `Reply with exactly the word: ${word}`
    await composer.fill(question)
    await composer.press("Enter")
    const conversation = page.getByRole("region", { name: "Conversation", exact: true })
    const answer = answerTo(conversation, question)
    await expect(answer).toHaveAttribute("data-state", "streaming", { timeout: 60_000 })
    await page.reload()

    await respond(agent, conversation, question, word)
    await expect(answer).toContainText(word, { timeout: 60_000 })
    await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
    await expect(questionIn(conversation, question)).toHaveCount(1)

    const next = `next-${Date.now()}`
    const followup = `Reply with exactly the word: ${next}`
    await page.keyboard.press("ControlOrMeta+k")
    await expect(composer).toBeFocused()
    await composer.fill(followup)
    await composer.press("Enter")
    await respond(agent, conversation, followup, next)
    await expect(answerTo(conversation, followup)).toContainText(next, { timeout: 60_000 })
  } finally {
    await agent.revoke()
  }
})

// What a person sees, not just what is in the page: `toBeInViewport`, where `toBeVisible` passes for an element
// scrolled out of sight. The conversation keeps its newest message in view, as the transcript's bottom anchor intends.
deviceTest("in view: opening chat shows the newest message and the Chat button, and a new question and its answer stay in view", { annotation: { type: "summary", description: "The newest message and its answer stay in view." } }, async ({ devices }) => {
  requires("ownConversation")
  const [a] = await devices.open("A")
  const page = a.page
  const agent = await attach(page)
  try {
    // A fresh branch can have no messages. Establish this test's own history, then open it again: opening must show
    // the newest answer without scrolling, whether the conversation is /app's or a branch's.
    const previous = `Reply with exactly the word: previous-${devices.word}`
    await a.askAndWaitTaken(previous)
    await respond(agent, a.conversation, previous, `previous-${devices.word}`)
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
    await respond(agent, conversation, question, word)
    await expect(answerTo(conversation, question)).toContainText(word, { timeout: 60_000 })
    await expect(answerTo(conversation, question), "its answer shows without scrolling").toBeInViewport()
    await expect(composer).toBeInViewport()
  } finally {
    await agent.revoke()
  }
})

// A message is one element from the moment it shows: a question syncing and its answer settling change it in place, so
// its fade-in plays once, not again at each change of status.
test("steady: a question and its answer keep their elements as the question syncs and the answer settles", { annotation: { type: "summary", description: "A question and its answer don't flicker as they sync and settle." } }, async ({ page }) => {
  requires("ownConversation")
  await page.goto(appHome())
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  const agent = await attach(page)
  try {
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
    await respond(agent, conversation, question, word)
    await expect(answer).toContainText(word, { timeout: 60_000 })
    await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false", { timeout: 60_000 })

    expect(await asked!.evaluate((element) => element.isConnected), "the question's element survived syncing").toBe(true)
    expect(await streaming!.evaluate((element) => element.isConnected), "the answer's element survived settling").toBe(true)
  } finally {
    await agent.revoke()
  }
})
