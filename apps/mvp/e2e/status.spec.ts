import type { Page } from "@playwright/test"
import { expect, type Tab, test } from "./devices"
import { requires, scriptedAgent } from "./target"

// Agent status, end to end (decision 0015, docs/features/agent-status.md): the agent asks the person with
// `app/agent/ask`, and the question shows in the conversation, the header, a toast and the tab's title, on every device
// the person has open; the person answers, and the agent's durable run in the asking browser goes on. The first test
// scripts the agent's model in the asking browser's engine worker (`/app?agent=needs-you`, src/test/scriptedAgent.ts),
// so it runs the same every time; the second asks the real model. Everything else is real: the engine, ChatApi, the runs
// routes, Postgres and Electric. Both ask, which needs a Member or above.
requires("personalModel", "member", "ownConversation")

const PROMPT = "Which branch should I deploy?"

/** How many questions need the person, by the tab's title: `(N) Smithers`, or 0. */
const titleCount = async (page: Page) => Number((await page.title()).match(/^\((\d+)\) /)?.[1] ?? 0)

/** The surfaces that show this answer's question on `tab`. */
const surfaces = (tab: Tab, answerId: string) => ({
  card: tab.page.locator(`[data-slot="needs-you"][data-run="${answerId}"]`),
  toast: tab.page.getByRole("region", { name: "Smithers" }).locator(`[data-slot="toast"][data-run="${answerId}"]`),
  // The top bar's bell (docs/features/notifications.md#the-top-bar).
  header: tab.page.getByRole("button", { name: /^Notifications/ }),
  // This run's entry in the notifications panel the bell opens. Runs an earlier test left open wait on the same person,
  // so the bell's count alone doesn't say this run is one of them; its entry does.
  entry: tab.page.getByRole("dialog", { name: "Notifications" }).locator(`[data-slot="notification"][data-entry="run:${answerId}"]`),
})

test("needs you: the agent asks, every surface on every device shows it, and an answer from another device resumes the run", { annotation: { type: "summary", description: "When the agent asks a question, every device shows it, and an answer from any device lets the run go on." } }, async ({ devices }) => {
  requires("scriptedAgent")
  test.setTimeout(120_000)
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  // A's engine worker answers with the scripted agent.
  await a.page.goto(scriptedAgent("needs-you"))
  await a.ready()
  const question = `Deploy the docs preview, ${word}`
  await a.askAndWaitTaken(question)
  const answerId = a.asked.find((asked) => asked.text === question)!.answerId

  for (const tab of [a, b]) {
    const { card, toast, header, entry } = surfaces(tab, answerId)
    await expect(card, `${tab.name}: the question shows in the conversation`).toBeVisible({ timeout: 30_000 })
    await expect(card).toHaveAttribute("role", "group")
    await expect(card).toHaveAccessibleName(PROMPT)
    await expect(card.getByRole("button", { name: "docs-v2" })).toBeVisible()
    // The toast is the feed's, its own shape (docs/features/notifications.md), so it can arrive a response after the card;
    // a person with many runs left open by earlier tests has a larger feed to sync first.
    await expect(toast, `${tab.name}: a toast says so, with Answer`).toContainText(`Needs you · ${PROMPT}`, { timeout: 30_000 })
    // The top bar's bell reads the same feed.
    await expect(header, `${tab.name}: the top bar says the agent needs you`).toContainText("Needs you", { timeout: 15_000 })
    await expect(header, `${tab.name}: screen readers hear the count waiting on them`)
      .toHaveAccessibleName(/^Notifications: [1-9]\d* needs? you(?:, [1-9]\d* unread)?$/)

    // Nothing covers it, the open composer included: a trial click finds the button takes the pointer.
    await toast.getByRole("button", { name: "Answer" }).click({ trial: true })
    // One click on the bell opens the panel at the newest run waiting on the person: this one, with its question.
    await header.click()
    await expect(entry, `${tab.name}: the bell opens at this run`).toHaveAttribute("data-expanded", "")
    await expect(entry.getByRole("button", { name: "docs-v2" })).toBeVisible()
    await tab.page.keyboard.press("Escape")
    // Questions an earlier run left open count too.
    await expect.poll(() => titleCount(tab.page), { message: `${tab.name}: the title counts it` }).toBeGreaterThan(0)
  }
  const open = { A: await titleCount(a.page), B: await titleCount(b.page) }

  // On B, the toast's Answer brings the question's field into focus; B answers there.
  await surfaces(b, answerId).toast.getByRole("button", { name: "Answer" }).click()
  const field = surfaces(b, answerId).card.getByRole("textbox", { name: "Your answer" })
  await expect(field).toBeFocused()
  await field.fill("docs-v2")
  await field.press("Enter")

  // A's engine holds the run: it gets the answer through sync, and its agent goes on.
  for (const tab of [a, b]) {
    const { card, toast, header, entry } = surfaces(tab, answerId)
    await tab.expectAnswered(question, "Deploying docs-v2.", 30_000)
    await expect(card, `${tab.name}: the question shows what was answered`).toHaveAttribute("data-state", "answered")
    await expect(card).toContainText("docs-v2")
    await expect(toast).toHaveCount(0, { timeout: 15_000 })
    // Questions an earlier run left open may close meanwhile too, so the count only has to drop.
    await expect.poll(() => titleCount(tab.page), { message: `${tab.name}: the title stops counting it` })
      .toBeLessThan(open[tab.name as "A" | "B"])
    // In the panel, this run no longer waits on the person.
    await header.click()
    await expect(entry, `${tab.name}: this run is done`).toContainText("Done", { timeout: 15_000 })
    await tab.page.keyboard.press("Escape")
  }
})

test("needs you, live: two devices show the question, Hide reaches both, and an answer resumes the real model", { annotation: { type: "summary", description: "The real model asks on both devices; Hide reaches both, and teal from B resumes A's run." } }, async ({ devices }) => {
  requires("personalModel", "member", "ownConversation")
  test.setTimeout(540_000)
  const word = devices.word
  const [a, b] = await test.step("Open both devices", () => devices.open("A", "B"))
  const question =
    `Use app/agent/ask to ask me which colour I want, as a question. Then reply with the colour I chose and the word ${word}.`
  const answerId = await test.step("Ask Smithers", async () => {
    await a.askAndWaitTaken(question)
    return a.asked.find((asked) => asked.text === question)!.answerId
  })

  await test.step("Both devices need you", () => Promise.all([a, b].map(async (tab) => {
    const { card, toast, header } = surfaces(tab, answerId)
    await Promise.all([
      expect(card, `${tab.name}: the live agent asked here`).toBeVisible({ timeout: 180_000 }),
      expect(toast, `${tab.name}: the question toasts`).toBeVisible({ timeout: 180_000 }),
      expect(toast.getByRole("button", { name: "Answer" })).toBeVisible({ timeout: 180_000 }),
      expect(header, `${tab.name}: the bell needs you`).toContainText("Needs you", { timeout: 180_000 }),
      expect(tab.page, `${tab.name}: the title counts open questions`).toHaveTitle(/^\([1-9]\d*\) /, { timeout: 180_000 }),
    ])
  })))
  const open = new Map([[a, await titleCount(a.page)], [b, await titleCount(b.page)]])

  await test.step("Hide on both devices", async () => {
    await b.page.keyboard.press("Alt+KeyT")
    await expect(surfaces(b, answerId).toast.locator('[data-slot="toast-open"]')).toBeFocused()
    await b.page.keyboard.press("h")
    await Promise.all([a, b].map((tab) =>
      expect(surfaces(tab, answerId).toast, `${tab.name}: Hide reaches this device`).toHaveCount(0, { timeout: 15_000 })
    ))
    for (const tab of [a, b]) {
      const { header, entry } = surfaces(tab, answerId)
      await header.click()
      await expect(entry, `${tab.name}: the hidden toast stays in notifications`).toBeVisible({ timeout: 15_000 })
      await expect(entry).toContainText("Needs you")
      await tab.page.keyboard.press("Escape")
    }
  })

  await test.step("B answers teal", async () => {
    const field = surfaces(b, answerId).card.getByRole("textbox", { name: "Your answer" })
    await field.fill("teal")
    await field.press("Enter")
  })

  await test.step("Both devices show the answer", () => Promise.all([a, b].map(async (tab) => {
    const { card } = surfaces(tab, answerId)
    await Promise.all([
      expect(card, `${tab.name}: the question is answered`).toHaveAttribute("data-state", "answered", { timeout: 180_000 }),
      expect(card).toContainText("teal", { timeout: 180_000 }),
      tab.expectAnswered(question, word, 180_000),
      expect(tab.answerTo(question)).toContainText(/teal/i, { timeout: 180_000 }),
      expect.poll(() => titleCount(tab.page), { message: `${tab.name}: the title stops counting it`, timeout: 180_000 })
        .toBeLessThan(open.get(tab)!),
    ])
  })))
})
