import { allServerRows, expect, expectSameThread, NOT_SENT, PAGE_SIZE, pairs, serverRows, test } from "./devices"
import { faultyApp, faults } from "./faults"
import { step } from "./fixtures"
import { questionPost, requires, target, writeHeaders } from "./target"

// Local-first guarantees across real devices (docs/decisions/0002-local-first.md §7): separate browser contexts, each
// keeping the conversation on the device (SQLite on OPFS) and every question in its outbox (IndexedDB) until Postgres
// has it. The asking device's agent answers, on its own durable engine. No mocks. `setOffline` is a device losing its network; a switch of the app's
// faulty services (e2e/faults.ts) is the sync service being down for one device. A page opened again in the same
// context is a reload or a restart: the same device. Every device records video: `pnpm e2e:gifs` makes one GIF per
// flow, and every page runs the no-spinner observer (e2e/fixtures.ts). The conversation is shared and keeps earlier
// runs, so every assertion is scoped to the test's own word (`devices.word`), and answers are matched on a word they
// contain, never exact wording. One-word answers keep the model's token use low; the few long answers are what make
// "mid-answer" possible. Every test asks, which needs a Member or above and, in a deployment, the test account's own
// conversation (e2e/target.ts); a test that throws a switch of the app's faulty services runs only on a dev build
// (`requires("faults")`).
requires("personalModel", "member", "ownConversation")

// A long answer that ends in a word of its own, so "complete" means its last line arrived.
const longQuestion = (start: string, end: string) =>
  `Write ${start} on the first line, then count from 1 to 120 in words, one number per line, then write ${end} on the last line.`

test("offline ask: two questions asked offline queue, survive a reload offline, and are answered in order once online", { annotation: { type: "summary", description: "Questions asked offline wait on the device, survive a reload, and are answered in order once online." } }, async ({ devices, request }) => {
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  await a.offline()
  await a.expectOffline()

  // A asks twice with no network: each question shows at once, queued, and the pill counts them.
  const first = `Reply with exactly the word: first-${word}`
  const second = `Reply with exactly the word: second-${word}`
  await a.ask(first)
  await a.ask(second)
  await a.expectQueued(first)
  await a.expectQueued(second)
  await a.expectOffline(2)

  // A reload offline: the service worker serves the app, the device its conversation and both queued questions.
  await a.reload()
  await a.expectOffline(2)
  await a.expectQueued(first)
  await a.expectQueued(second)
  expect(a.asked.filter(({ status }) => status !== undefined), "nothing reached ChatApi").toEqual([])

  // Online: both reach Postgres once each, in the order asked, and both are answered, on A and on B.
  await a.online()
  await a.expectAnswered(first, `first-${word}`)
  await a.expectAnswered(second, `second-${word}`)
  await a.expectUp()
  const thread = await expectSameThread([a, b], word, 4)
  expect(pairs(thread).map(([question]) => question.text)).toEqual([first, second])
  const rows = await serverRows(request, word)
  expect(rows.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual([first, second])
})

test("restart offline: a question asked offline survives closing the app, and a page opened again sends it once", { annotation: { type: "summary", description: "A question asked offline survives closing the app and is sent once when it opens again." } }, async ({ devices, request }) => {
  const word = devices.word
  const [a] = await devices.open("A")
  await a.offline()
  const asked = `Reply with exactly the word: restart-${word}`
  await a.ask(asked)
  await a.expectOffline(1)
  // The app closes with the question stored, never sent; it opens again, still offline.
  await a.page.close()
  const again = await devices.tab(a.device, "A again")
  await again.expectOffline(1)
  await again.expectQueued(asked)
  await again.online()
  await again.expectAnswered(asked, `restart-${word}`)
  const rows = await serverRows(request, word)
  expect(rows.map(({ role }) => role)).toEqual(["user", "assistant"])
})

test("offline branch: its queued questions and count survive a reload and closing the app", {
  annotation: { type: "summary", description: "A saved branch conversation and its queued count reopen offline without a server answer." },
}, async ({ devices }) => {
  const [a] = await devices.open("A")
  // The production suite opens its own branch already. Locally use the public fixture from branch-workspace.spec.ts;
  // tracking reads an existing ref, and never writes to GitHub. Nothing in this test asks the model.
  if (target === "local") await step("Open the branch conversation", async () => {
    await a.page.goto("/octocat/Spoon-Knife/tree/test-branch")
    await expect(a.conversation).toBeVisible({ timeout: 30_000 })
    await expect(a.page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0)
  })
  const path = new URL(a.page.url()).pathname
  await a.offline()
  const first = `Keep first-${devices.word}`
  const second = `Keep second-${devices.word}`
  await a.ask(first)
  await a.ask(second)
  await a.expectQueued(first)
  await a.expectQueued(second)
  await a.expectOffline(2)
  await step("Reload the branch offline", () => a.page.reload())
  await a.expectOffline(2)
  await a.expectQueued(first)
  await a.expectQueued(second)
  await expect(a.conversation.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
  await a.close()
  const again = await devices.tab(a.device, "A again")
  await step("Reopen the saved branch offline", () => again.page.goto(path))
  await again.expectOffline(2)
  await again.expectQueued(first)
  await again.expectQueued(second)
  await expect(again.page.locator('[aria-label="Connection"]')).toHaveCount(1)
  expect(a.asked.filter(({ status }) => status !== undefined)).toEqual([])
})

test("closed before its run started: a question ChatApi took, whose tab closed before its engine recorded the run, is answered when the app opens again", { annotation: { type: "summary", description: "A question whose tab closed before it was answered is answered when the app opens again." } }, async ({ devices, request }) => {
  requires("faults")
  const word = devices.word
  const [a] = await devices.openFaulty("A")
  // This tab's engine takes its time, as a worker still loading wa-sqlite: the run that answers isn't recorded yet.
  await faults(a.page).engine.holdStarts()
  const asked = `Reply with exactly the word: unstarted-${word}`
  await a.askAndWaitTaken(asked)
  // Postgres has the question and its empty answer, and Electric delivered both. Then the tab closes.
  await expect(a.answerTo(asked), "the answer's row arrived").toHaveAttribute("data-role", "assistant", { timeout: 30_000 })
  await a.close()

  // The app opens again on the device: the outbox still holds the question, sends it again, and the agent answers.
  const again = await devices.tab(a.device, "A again")
  await again.expectAnswered(asked, `unstarted-${word}`)
  const rows = await serverRows(request, word)
  expect(rows.map(({ role }) => role)).toEqual(["user", "assistant"])
})

test("late joiner: a device that opens later shows the same latest messages, and Load earlier pages back through Postgres' order", { annotation: { type: "summary", description: "A device that opens later shows the same conversation, and Load earlier pages back in order." } }, async ({ devices, request }) => {
  const word = devices.word
  const asked = [`Reply with exactly the word: first-${word}`, `Reply with exactly the word: second-${word}`]
  await step("Record a conversation longer than one page", async () => {
    // A real client writes completed exchanges before either device joins. No model is needed to prove paging.
    const history = crypto.randomUUID()
    const questions = [
      ...Array.from({ length: Math.ceil(PAGE_SIZE / 2) }, (_, n) => `Earlier exchange ${n + 1}: ${history}`),
      ...asked,
    ]
    for (const [n, text] of questions.entries()) {
      const id = crypto.randomUUID()
      const answerId = crypto.randomUUID()
      const question = await request.post("/api/questions", questionPost({ id, answerId, text }))
      expect(question.status()).toBe(202)
      const answer = await request.post(`/api/answers/${answerId}`, { data: { status: "done", text: `Recorded exchange ${n + 1}.` }, headers: writeHeaders() })
      expect(answer.status()).toBe(200)
    }
  })
  const [a] = await devices.open("A")

  // A new device, with nothing in memory, gets this test's messages exactly as A has them...
  const [late] = await devices.open("Late")
  const thread = await expectSameThread([a, late], word, 4)
  expect(pairs(thread).map(([question]) => question.text)).toEqual(asked)

  // ...and the same latest page of the conversation: every message, in the same order, with the same text.
  const total = (await allServerRows(request)).length
  await expect(async () => {
    const [onA, onLate] = await Promise.all([a.transcript(), late.transcript()])
    expect(onLate).toHaveLength(Math.min(PAGE_SIZE, total))
    expect(onLate).toEqual(onA)
  }).toPass({ timeout: 30_000 })

  // Load earlier pages back: the late device then shows the latest two pages, questions in Postgres' order.
  expect(total, "the conversation holds more than one page").toBeGreaterThan(PAGE_SIZE)
  await expect(late.loadEarlier).toBeVisible()
  await step("Read the previous page on the new device", () => late.loadEarlier.click())
  await expect(async () => {
    const [onLate, rows] = await Promise.all([late.transcript(), allServerRows(request)])
    const latest = rows.slice(-2 * PAGE_SIZE)
    expect(onLate).toHaveLength(latest.length)
    expect(onLate.map(({ role }) => role)).toEqual(latest.map(({ role }) => role))
    expect(onLate.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual(
      latest.filter(({ role }) => role === "user").map(({ text }) => text),
    )
  }).toPass({ timeout: 30_000 })
})

test("two tabs: each keeps its own composer; the tab a person asks in leads, and sends at once", { annotation: { type: "summary", description: "Each tab keeps its own draft, and the tab a person asks in sends at once." } }, async ({ devices }) => {
  const word = devices.word
  const [one] = await devices.open("Tab 1")
  const two = await devices.tab(one.device, "Tab 2")

  // The composer belongs to its tab: tab 1's is open with a draft, tab 2's stays hidden, then opens empty.
  const draft = `Reply with exactly the word: draft-${word}`
  await one.openComposer()
  await one.composer.fill(draft)
  await expect(two.chatButton).toBeVisible()
  await expect(two.composer).toBeHidden()
  await two.openComposer()
  await expect(two.composer).toHaveValue("")
  await expect(one.composer).toHaveValue(draft)

  // Tab 1 leads the outbox (it opened first): its question is answered, and tab 2 watches it.
  await one.composer.press("Enter")
  await two.expectAnswered(draft, `draft-${word}`)

  // Tab 2 asks while tab 1 led: its composer took focus, so tab 2 leads and sends at once, with tab 1 still open.
  const handed = `Reply with exactly the word: handed-${word}`
  await two.ask(handed)
  await two.expectAnswered(handed, `handed-${word}`)
  // And back: tab 1 asks, leads again, and is answered.
  const back = `Reply with exactly the word: back-${word}`
  await one.ask(back)
  await one.expectAnswered(back, `back-${word}`)
  const thread = await expectSameThread([one, two], word, 6)
  expect(pairs(thread).map(([question]) => question.text)).toEqual([draft, handed, back])
  // Neither question ever waited as Not sent.
  for (const tab of [one, two]) await expect(tab.page.getByText(NOT_SENT, { exact: true })).toHaveCount(0)
})

test("two tabs offline: the leading tab closes, and the other restores its queued question and sends it once online", { annotation: { type: "summary", description: "When the tab holding a queued question closes, the other tab sends it once online." } }, async ({ devices, request }) => {
  const word = devices.word
  const [one] = await devices.open("Tab 1")
  const two = await devices.tab(one.device, "Tab 2")
  await one.offline()
  const asked = `Reply with exactly the word: tabs-${word}`
  await one.ask(asked)
  await one.expectQueued(asked)
  await one.page.close()
  // Tab 2 leads now: it restores the question tab 1 stored, and sends it once the device is back online.
  await two.expectQueued(asked)
  await two.online()
  await two.expectAnswered(asked, `tabs-${word}`)
  const rows = await serverRows(request, word)
  expect(rows.map(({ role }) => role)).toEqual(["user", "assistant"])
})

test("concurrent asks: two devices ask at the same moment, and each question gets exactly one answer, in one order everywhere", { annotation: { type: "summary", description: "Two devices asking at the same moment each get one answer, in the same order everywhere." } }, async ({ devices, request }) => {
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  const alpha = `Reply with exactly the word: alpha-${word}`
  const bravo = `Reply with exactly the word: bravo-${word}`
  await a.openComposer()
  await b.openComposer()
  await a.composer.fill(alpha)
  await b.composer.fill(bravo)
  await Promise.all([a.composer.press("Enter"), b.composer.press("Enter")])

  const thread = await expectSameThread([a, b], word, 4)
  const answers = new Map(pairs(thread).map(([question, answer]) => [question.text, answer.text]))
  expect([...answers.keys()].sort()).toEqual([alpha, bravo])
  expect(answers.get(alpha)).toContain(`alpha-${word}`)
  expect(answers.get(alpha)).not.toContain(`bravo-${word}`)
  expect(answers.get(bravo)).toContain(`bravo-${word}`)
  expect(answers.get(bravo)).not.toContain(`alpha-${word}`)
  // Each device asked once, and Postgres holds each question with its own answer right after it.
  expect(a.asked.map(({ text, status }) => ({ text, status }))).toEqual([{ text: alpha, status: 202 }])
  expect(b.asked.map(({ text, status }) => ({ text, status }))).toEqual([{ text: bravo, status: 202 }])
  const rows = await serverRows(request, word)
  expect(rows.map(({ role }) => role)).toEqual(["user", "assistant", "user", "assistant"])
  for (const index of [0, 2]) {
    expect(rows[index + 1]!.question_id, "each answer follows its own question").toBe(rows[index]!.id)
    expect(Number(rows[index + 1]!.position)).toBeGreaterThan(Number(rows[index]!.position))
  }
  expect(rows.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual(pairs(thread).map(([question]) => question.text))
})

test("tab closes mid-answer: the answer waits for the asking device, and completes on both devices once it opens the app again", { annotation: { type: "summary", description: "An answer whose tab closed finishes on every device once that device opens the app again." } }, async ({ devices, request }) => {
  test.setTimeout(180_000)
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  const asked = longQuestion(`gone-${word}`, `end-${word}`)
  await a.askAndWaitTaken(asked)
  await expect(a.answerTo(asked), "the answer starts").toContainText(`gone-${word}`, { timeout: 60_000 })

  // The asking device's tab closes while its agent is answering. The run belongs to that device (decision 0011), so
  // the answer waits; the device keeps the run's journal.
  await a.close()
  await expect(b.answerTo(asked)).toContainText(`gone-${word}`)

  // The device opens the app again: its engine resumes the run, and both devices see the whole answer.
  const again = await devices.tab(a.device, "A again")
  for (const tab of [b, again]) await tab.expectAnswered(asked, `end-${word}`)
  const [question, answer] = await serverRows(request, word)
  expect(question?.text).toBe(asked)
  expect(answer?.status).toBe("done")
  expect(answer?.text).toContain(`end-${word}`)
})

test("reload mid-answer: the asking device reloads while another watches, and both see the answer complete", { annotation: { type: "summary", description: "A device that reloads mid-answer and another watching both see the answer finish." } }, async ({ devices }) => {
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  const asked = longQuestion(`reload-${word}`, `end-${word}`)
  await a.askAndWaitTaken(asked)
  await a.reload()

  for (const tab of [b, a]) await tab.expectAnswered(asked, `end-${word}`)
  await expectSameThread([a, b], word, 2)

  // A's chat works after the reload: the next question is answered on both devices.
  const next = `Reply with exactly the word: after-${word}`
  await a.ask(next)
  await b.expectAnswered(next, `after-${word}`)
  const thread = await expectSameThread([a, b], word, 4)
  expect(pairs(thread).map(([question]) => question.text)).toEqual([asked, next])
})

test("long outage: a device offline catches up on everything asked meanwhile", { annotation: { type: "summary", description: "A device that was offline catches up on everything asked meanwhile." } }, async ({ devices }) => {
  test.setTimeout(180_000)
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  await a.offline()

  // The browser's offline event shows the pill at once; from then on nothing reaches A.
  await a.expectOffline()

  const meanwhile = [`Reply with exactly the word: away1-${word}`, `Reply with exactly the word: away2-${word}`]
  for (const [index, question] of meanwhile.entries()) {
    await b.ask(question)
    await b.expectAnswered(question, `away${index + 1}-${word}`)
  }
  for (const question of meanwhile) await expect(a.question(question)).toHaveCount(0)
  await a.expectOffline()

  // Back online, A syncs at once: the pill hides by itself and A has both questions and answers, as B has them.
  const back = Date.now()
  await a.online()
  await a.expectUp()
  const thread = await expectSameThread([a, b], word, 4, 30_000)
  expect(pairs(thread).map(([question]) => question.text)).toEqual(meanwhile)
  test.info().annotations.push({ type: "catch-up", description: `${Date.now() - back} ms from online to A showing both answers` })
})

test("flapping network: a question asked during each drop queues, and every one reaches Postgres once, in order", { annotation: { type: "summary", description: "Questions asked while the network drops and returns each reach the server once, in order." } }, async ({ devices, request }) => {
  test.setTimeout(180_000)
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  const asked: Array<string> = []
  for (const round of [1, 2, 3]) {
    await a.offline()
    const question = `Reply with exactly the word: flap${round}-${word}`
    await a.ask(question)
    await a.expectQueued(question)
    asked.push(question)
    await a.online()
    await a.expectAnswered(question, `flap${round}-${word}`)
  }

  // A and B show the three questions, once each, in the order asked, each answered.
  const thread = await expectSameThread([a, b], word, 6)
  expect(pairs(thread).map(([question]) => question.text)).toEqual(asked)
  for (const [index, [, answer]] of pairs(thread).entries()) expect(answer.text).toContain(`flap${index + 1}-${word}`)
  const rows = await serverRows(request, word)
  expect(rows.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual(asked)
})

test("sync down while asking: a question ChatApi took stays queued until the device sees it, then shows once, answered", { annotation: { type: "summary", description: "A question the server took stays queued on the device until sync shows it, then shows once, answered." } }, async ({ devices }) => {
  requires("faults")
  test.setTimeout(180_000)
  const word = devices.word
  const [[a], [b]] = await Promise.all([devices.openFaulty("A"), devices.open("B")])

  // The sync service goes down for A only; requests failing for 10 s show the pill, with Retry.
  await a.device.syncDown()
  const asked = `Reply with exactly the word: unsynced-${word}`
  await a.askAndWaitTaken(asked)
  await expect(a.pill.getByRole("button", { name: "Retry" }), "A offers Retry").toBeVisible({ timeout: 60_000 })
  await expect(b.pill).toBeEmpty()

  // ChatApi took A's question and answered it; B sees the answer. A can't see it yet, so it stays queued on A.
  await b.expectAnswered(asked, `unsynced-${word}`)
  await a.expectQueued(asked)

  // Sync returns: A shows Postgres' rows in place of its queued question, once, answered.
  await a.device.syncUp()
  await a.pill.getByRole("button", { name: "Retry" }).click()
  await a.expectAnswered(asked, `unsynced-${word}`, 30_000)
  await a.expectUp()
  await expectSameThread([a, b], word, 2)
})

test("Retry: syncs at once instead of waiting out the backoff", { annotation: { type: "summary", description: "Retry syncs at once instead of waiting out the backoff." } }, async ({ devices }) => {
  requires("faults")
  test.setTimeout(120_000)
  const [[a]] = await Promise.all([devices.openFaulty("A")])
  await a.device.syncDown()
  // Something must change for the live request Electric holds to end, so the next request fails: the device asks, and
  // its own agent answers, as a person's question would. (A question posted from outside the app has no browser to
  // answer it, so its streaming answer would hold later answers in the shared conversation up.)
  const asked = `Reply with exactly the word: retry-${devices.word}`
  await a.ask(asked)
  const retry = a.pill.getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible({ timeout: 60_000 })
  await a.device.syncUp()
  const sent = a.page.waitForRequest((request) => new URL(request.url()).pathname === "/api/shapes/messages", { timeout: 1_000 })
  await retry.click()
  await sent
  await a.expectAnswered(asked, `retry-${devices.word}`)
  await a.expectUp()
})

test("offline mid-answer: the text so far stays, and the whole answer arrives once back online", { annotation: { type: "summary", description: "Going offline mid-answer keeps the text so far, and the rest arrives once back online." } }, async ({ devices }) => {
  test.setTimeout(180_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const asked = longQuestion(`mid-${word}`, `end-${word}`)
  await a.askAndWaitTaken(asked)
  await expect(a.answerTo(asked), "the answer starts").toContainText(`mid-${word}`, { timeout: 60_000 })
  await a.offline()
  await a.expectOffline()
  await expect(a.answerTo(asked)).toContainText(`mid-${word}`)
  await a.online()
  await a.expectAnswered(asked, `end-${word}`)
})

test("Electric down at boot: after one visit, the conversation shows from the device, and the pill says so", { annotation: { type: "summary", description: "With sync down at boot, the conversation still shows from the device, and the pill says so." } }, async ({ devices }) => {
  requires("faults")
  test.setTimeout(120_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const asked = `Reply with exactly the word: stored-${word}`
  await a.ask(asked)
  await a.expectAnswered(asked, `stored-${word}`)
  // The app opens again on its faulty services with the sync service already down.
  await a.page.goto(faultyApp("down"))
  await a.ready()
  await a.expectAnswered(asked, `stored-${word}`, 5_000)
  await expect(a.pill.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 60_000 })
})

test("back/forward: leaving the app and coming back shows the same conversation, and it still asks", { annotation: { type: "summary", description: "Leaving the app and coming back shows the same conversation, and asking still works." } }, async ({ devices }) => {
  const word = devices.word
  const [a] = await devices.open("A")
  const asked = `Reply with exactly the word: before-${word}`
  await a.ask(asked)
  await a.expectAnswered(asked, `before-${word}`)
  await a.page.goto("/")
  await a.page.goBack()
  await a.ready()
  await a.expectAnswered(asked, `before-${word}`, 10_000)
  const after = `Reply with exactly the word: after-${word}`
  await a.ask(after)
  await a.expectAnswered(after, `after-${word}`)
})
