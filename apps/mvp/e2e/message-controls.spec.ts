import type { Locator, Page } from "@playwright/test"
import { expect, serverRows, test } from "./devices"
import { requires } from "./target"

// Message controls in a real browser (docs/features/chat.md#message-controls): Copy on an answer puts its text on the
// clipboard through `chat/copy`, every message shows when it was written, Edit takes a question queued offline back to
// the composer before the outbox sends it (`chat/edit`), and the composer's draft survives a reload. A message's time,
// Copy and Edit show only while the pointer is over it. Real app, Worker, Postgres, Electric and model; no mocks.
// `pnpm e2e:gifs` makes this flow's GIF from its video. Both tests ask, which needs a Member or above.
requires("personalModel", "member", "ownConversation")

// A message's time and controls (`@smthrs/ui`'s ChatMessage actions): in the page, keeping their space, but unseen.
const controls = (message: Locator) => message.locator(".sui-chat-message-actions")
const hidden = (message: Locator, what: string) => expect(controls(message), `${what} hidden`).toHaveCSS("opacity", "0")
const shown = (message: Locator, what: string) => expect(controls(message), `${what} shown`).toHaveCSS("opacity", "1")
// The pointer over the page's header, away from every message.
const away = (page: Page) => page.mouse.move(4, 4)

test("message copy: Copy puts an answer on the clipboard, and every message shows its time", async ({ devices }) => {
  requires("liveModel")
  const word = devices.word
  const [a] = await devices.open("A")
  await a.device.context.grantPermissions(["clipboard-read", "clipboard-write"])

  // An answer, with the time on both messages.
  const asked = `Reply with exactly the word: copy-${word}`
  await a.ask(asked)
  await a.expectAnswered(asked, `copy-${word}`)
  await expect(a.question(asked).locator("time"), "the question shows its time").toHaveText(/ago|just now/)
  await expect(a.answerTo(asked).locator("time"), "the answer shows its time").toHaveText(/ago|just now/)

  // The time and Copy show only while the pointer is over a message.
  await away(a.page)
  await hidden(a.question(asked), "the question's time")
  await hidden(a.answerTo(asked), "the answer's time and Copy")
  await a.answerTo(asked).hover()
  await shown(a.answerTo(asked), "on hover, the answer's time and Copy")
  await hidden(a.question(asked), "the question's time, not hovered")

  // Copy on the answer: the clipboard has its text, and the button says so.
  await a.answerTo(asked).getByRole("button", { name: "Copy", exact: true }).click()
  await expect(a.answerTo(asked).getByRole("button", { name: "Copied", exact: true })).toBeVisible()
  await expect.poll(() => a.page.evaluate(() => navigator.clipboard.readText()), { timeout: 30_000 }).toContain(`copy-${word}`)
})

test("message edit: Edit takes a question queued offline back to the composer before it is sent, and a draft survives a reload", async ({ devices, request }) => {
  const word = devices.word
  const [a] = await devices.open("A")

  // Offline, a question with a typo waits in the outbox; Edit takes it back to the composer before it is sent.
  await a.offline()
  const typo = `Reply with exactly the word: tpyo-${word}`
  await a.ask(typo)
  await a.expectQueued(typo)
  await expect(a.question(typo).locator("time"), "a queued question shows when it was asked").toHaveText(/ago|just now/)
  await away(a.page)
  await hidden(a.question(typo), "the queued question's time and Edit")
  await a.question(typo).hover()
  await shown(a.question(typo), "on hover, the queued question's time and Edit")
  await a.question(typo).getByRole("button", { name: "Edit", exact: true }).click()
  await expect(a.composer, "the question's text is back in the composer").toHaveValue(typo)
  await expect(a.question(typo), "the queued question is gone").toHaveCount(0)
  const fixed = `Reply with exactly the word: fixed-${word}`
  await a.composer.fill(fixed)
  await a.composer.press("Enter")
  await a.expectQueued(fixed)

  // Online: only the fixed question reaches Postgres.
  await a.online()
  await expect(a.question(fixed), "the fixed question is stored").toHaveAttribute("data-state", "done", { timeout: 30_000 })
  const rows = await serverRows(request, word)
  expect(rows.filter(({ role }) => role === "user").map(({ text }) => text), "the typo never reached Postgres").toEqual([fixed])

  // A draft survives a reload.
  const draft = `half a thought ${word}`
  await a.openComposer()
  await a.composer.fill(draft)
  await expect(a.composer, "the device has stored the draft").toHaveAttribute("data-draft", "saved")
  await a.reload()
  await a.openComposer()
  await expect(a.composer, "the draft is back after the reload").toHaveValue(draft)
})
