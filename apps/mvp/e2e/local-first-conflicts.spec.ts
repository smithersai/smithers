import type { APIRequestContext } from "@playwright/test"
import { COULDNT_ANSWER, expect, expectSameThread, NOT_SENT, pairs, serverRows, type Tab, test } from "./devices"
import { faults, faultyApp } from "./faults"
import { step } from "./fixtures"
import { appHome, questionPost, requires, writeHeaders } from "./target"

// Every kind of conflict the device store and the outbox resolve (docs/decisions/0002-local-first.md §2, §3 and §5;
// docs/decisions/0016-todos-and-the-stack.md), one test each, on separate devices (browser contexts) or two tabs of one
// device, against the real app, ChatApi, Postgres, Electric and model. Each test's steps are its video's chapters. Every
// question asks for one word, so answers are matched on that word, never on exact wording.
//
// Faults are the app's faulty services (e2e/faults.ts) and a device's network is `setOffline`: nothing intercepts a
// request or replaces our code. The two clock tests set a device's clock with Playwright's clock, the way the system
// clock moves, which Will approved for them only (ruling TEST-12, 2026-10-20 23:37).
//
// Three tests are marked broken (`test.fail`, docs/rulings.md TEST-5) just before the assertion the bug fails, so a failure
// anywhere before it is still a failure. Once the bug is fixed the assertion passes, the run goes red, and the mark
// comes off.

/** Why each broken test fails today. */
const BROKEN_WITHDRAW = "Broken: Outbox.withdraw takes back a write the server already took, between two of its sends"
const BROKEN_GHOST = "Broken: a tab that loses the outbox's lead keeps the rows of writes another tab then takes back"
const BROKEN_CLOCK =
  "Broken: after the device clock steps back, the device shows the next question twice, and the outbox orders its writes by that clock"

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/** Opens the app again on `tab`, on its device's services, faulty or real, unless `faulty` says which. */
const reopen = (tab: Tab, faulty = tab.device.faulty) =>
  step(`${tab.name} opens the app again`, async () => {
    await tab.page.goto(faulty ? faultyApp() : appHome())
    await tab.ready()
  })

const question = (word: string) => `Reply with exactly the word: ${word}`

/** The user questions Postgres holds for this test, in its order. */
const storedQuestions = async (request: APIRequestContext, word: string) =>
  (await serverRows(request, word)).filter(({ role }) => role === "user").map(({ text }) => text)

/** The tabs' posts of `text` that ChatApi answered, in order; an attempt the network dropped (offline) isn't one. */
const posts = (tabs: ReadonlyArray<Tab>, text: string) =>
  tabs.flatMap((tab) => tab.asked.filter((asked) => asked.text === text && asked.status !== undefined))

test.describe("Local-first conflicts", () => {
  // Two devices, a sync of each change and an answer per question: more than the default 90 s.
  test.describe.configure({ timeout: 180_000 })
  // Every test asks, which needs a Member or above, and in a deployment the test account's own conversation. A test on
  // the app's faulty services or with local development's second person also declares that (e2e/target.ts).
  requires("personalModel", "member", "ownConversation")

  test("same question id: another writer stores a different question under the id a device queued offline; the device keeps its own, Not sent, and Edit asks it again", {
    annotation: {
      type: "summary",
      description: "Two writers claim one question id: Postgres keeps the first, A keeps its own Not sent, and Edit asks it again under a new id.",
    },
  }, async ({ devices, request }) => {
    requires("liveModel")
    const word = devices.word
    const [a, b] = await devices.open("A", "B")
    const mine = question(`mine-${word}`)
    const theirs = question(`theirs-${word}`)

    let id = ""
    await step("A asks offline: its question waits in its outbox", async () => {
      await a.offline()
      await a.ask(mine)
      await a.expectQueued(mine)
      id = await a.idOf(mine)
    })

    // Another client of ChatApi's API asks under the same question id, and answers its own question through the answer
    // routes, as an asking device's agent does.
    await step("Another writer stores a different question under the same id; B shows it", async () => {
      const answerId = crypto.randomUUID()
      const asked = await request.post("/api/questions", questionPost({ id, answerId, text: theirs }))
      expect(asked.status(), await asked.text()).toBe(202)
      const answered = await request.post(`/api/answers/${answerId}`, { data: { status: "done", text: `theirs-${word}` }, headers: writeHeaders() })
      expect(answered.status(), await answered.text()).toBe(200)
      await b.expectAnswered(theirs, `theirs-${word}`)
    })

    await step("A comes back: ChatApi refuses A's question under that id (409), and A keeps it, Not sent", async () => {
      await a.online()
      await a.expectNotSent(mine)
      expect(posts([a], mine).map(({ status }) => status)).toEqual([409])
      await a.expectAnswered(theirs, `theirs-${word}`)
      await expect(b.question(mine), "B never shows A's copy").toHaveCount(0)
    })

    await step("Edit puts A's question back in the composer; sent again, it gets a new id and is answered on both devices", async () => {
      await a.question(mine).getByRole("button", { name: "Edit", exact: true }).click()
      await expect(a.composer).toHaveValue(mine)
      await expect(a.question(mine)).toHaveCount(0)
      await a.composer.press("Enter")
      for (const tab of [a, b]) await tab.expectAnswered(mine, `mine-${word}`)
    })

    const thread = await expectSameThread([a, b], word, 4)
    expect(pairs(thread).map(([asked]) => asked.text)).toEqual([theirs, mine])
    const rows = await serverRows(request, word)
    expect(rows.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual([theirs, mine])
    expect(rows.find(({ text }) => text === mine)?.id, "A's question took a new id").not.toBe(id)

    // The device stored that Edit took the Not sent copy away: before the timeline's summaries were bounded to the
    // window, their runs held the device store's writes back, and a reload brought the copy back.
    await step("A reloads: its question shows once, answered, and the copy Edit took stays gone", async () => {
      await a.reload()
      await a.expectAnswered(mine, `mine-${word}`)
      await expectSameThread([a, b], word, 4)
    })
  })

  test("same TODO on two devices: Ann and Ben both drop a TODO offline; whichever comes back first drops it, and the other's drop changes nothing", {
    annotation: {
      type: "summary",
      description: "Two people drop the same TODO while offline: the first drop to arrive wins, the second changes nothing, and both see it Dropped once.",
    },
  }, async ({ devices }) => {
    requires("devPeople")
    test.setTimeout(240_000)
    const word = devices.word
    const [ann] = await devices.open("Ann")
    const [ben] = await devices.openTeammate("Ben")
    const title = `Drop twice ${word}`

    let number = ""
    await step("Ann writes a TODO and commits it: it gets a number", async () => {
      await openStack(ann)
      await ann.page.getByRole("button", { name: "New TODO" }).click()
      const draft = ann.page.getByRole("form", { name: "TODO draft" }).first()
      await draft.getByLabel("Title").fill(title)
      await draft.getByLabel("Prompt").fill("Dropped on two devices at once.")
      await draft.getByRole("button", { name: "Commit" }).click()
      await expect(todoRow(ann, word)).toContainText(/T\d+/, { timeout: 60_000 })
      await expect(todoRow(ann, word)).not.toHaveAttribute("data-pending", /.+/, { timeout: 60_000 })
      number = (await todoRow(ann, word).textContent())!.match(/T(\d+)/)![1]!
    })

    await step("Ben opens the stack: the same TODO, the same number", async () => {
      await openStack(ben)
      await expect(todoRow(ben, word)).toContainText(`T${number}`, { timeout: 60_000 })
    })

    await step("Both go offline, and both drop it", async () => {
      await ann.offline()
      await ben.offline()
      for (const tab of [ann, ben]) await drop(tab, word, number)
    })

    await step("Ben comes back first: his drop drops it", async () => {
      await ben.online()
      await expectDropped(ben, word)
    })

    await step("Ann comes back: her drop changes nothing, and she sees it Dropped too", async () => {
      await ann.online()
      await expectDropped(ann, word)
    })

    for (const tab of [ann, ben]) {
      await expect(tab.page.getByText(NOT_SENT, { exact: true }), `${tab.name}: no drop is left Not sent`).toHaveCount(0)
    }
  })

  test("back in either order: two devices ask offline, and whichever comes back first goes first, in one order on both devices and in Postgres", {
    annotation: {
      type: "summary",
      description: "A and B ask offline twice; B comes back first, then A first: Postgres' arrival order decides, the same on both devices.",
    },
  }, async ({ devices, request }) => {
    requires("liveModel")
    const word = devices.word
    const [a, b] = await devices.open("A", "B")
    const asked = { a1: question(`a1-${word}`), b1: question(`b1-${word}`), a2: question(`a2-${word}`), b2: question(`b2-${word}`) }

    const round = (title: string, first: Tab, second: Tab, fromFirst: string, fromSecond: string) =>
      step(title, async () => {
        await a.offline()
        await b.offline()
        await second.ask(fromSecond)
        await first.ask(fromFirst)
        await first.online()
        await first.expectAnswered(fromFirst, fromFirst.split(": ")[1]!)
        await second.online()
        await second.expectAnswered(fromSecond, fromSecond.split(": ")[1]!)
      })

    // The device that comes back first asked second, so the order is the order they came back in, not the order asked.
    await round("Both offline, A asks then B; B comes back first", b, a, asked.b1, asked.a1)
    await round("Both offline again, B asks then A; A comes back first", a, b, asked.a2, asked.b2)

    const thread = await expectSameThread([a, b], word, 8)
    const order = [asked.b1, asked.a1, asked.a2, asked.b2]
    expect(pairs(thread).map(([question]) => question.text)).toEqual(order)
    expect(await storedQuestions(request, word)).toEqual(order)
  })

  test("duplicate send: ChatApi took the question but its answer to the device was lost; the device sends it again, and it is stored and answered once", {
    annotation: {
      type: "summary",
      description: "A's question reaches ChatApi but the reply is lost, so A sends it again: ChatApi says it has it, and everyone sees it once.",
    },
  }, async ({ devices, request }) => {
    requires("faults", "liveModel")
    const word = devices.word
    const [[a], [b]] = await Promise.all([devices.openFaulty("A"), devices.open("B")])
    const asked = question(`once-${word}`)

    await step("A asks, and the network loses ChatApi's reply", async () => {
      await faults(a.page).questions.failNext("timeout")
      await a.ask(asked)
    })

    await step("A sends it again: ChatApi answers that it has it already (200), and it is answered once", async () => {
      await expect.poll(() => posts([a], asked).map(({ status }) => status), { timeout: 30_000 }).toEqual([202, 200])
      for (const tab of [a, b]) await tab.expectAnswered(asked, `once-${word}`)
      await expectSameThread([a, b], word, 2)
    })

    const [first] = posts([a], asked)
    await step("The same question through the API again, ids and all: 200, and nothing new", async () => {
      const again = await request.post("/api/questions", questionPost({ id: first!.questionId, answerId: first!.answerId, text: asked }))
      expect(again.status()).toBe(200)
      expect(await again.json()).toEqual({ txid: null, existing: true })
    })

    await step("The same id with another answer id: refused (409), and nothing is written", async () => {
      const other = await request.post("/api/questions", questionPost({ id: first!.questionId, answerId: crypto.randomUUID(), text: asked }))
      expect(other.status()).toBe(409)
    })

    const rows = await serverRows(request, word)
    expect(rows.map(({ id, role, status }) => ({ id, role, status }))).toEqual([
      { id: first!.questionId, role: "user", status: "done" },
      { id: first!.answerId, role: "assistant", status: "done" },
    ])
    await expectSameThread([a, b], word, 2)
  })

  test("stale tab: a tab that lost the outbox's lead to another and leads again doesn't send the question the other tab sent", {
    annotation: {
      type: "summary",
      description: "Tab 1 queues a question, tab 2 takes the lead and sends it, tab 1 leads again: the question is sent once, everywhere once.",
    },
  }, async ({ devices, request }) => {
    requires("liveModel")
    const word = devices.word
    const [one, b] = await devices.open("Tab 1", "B")
    const two = await devices.tab(one.device, "Tab 2")
    const first = question(`first-${word}`)
    const second = question(`second-${word}`)
    const third = question(`third-${word}`)

    await step("A goes offline; tab 1 asks, leads the outbox, and its question waits", async () => {
      await one.offline()
      await one.ask(first)
      await one.expectQueued(first)
    })

    await step("Tab 2 asks: it takes the lead, and shows both questions waiting", async () => {
      await two.ask(second)
      await two.expectQueued(first)
      await two.expectQueued(second)
    })

    await step("A comes back: tab 2 sends both, in the order asked", async () => {
      await two.online()
      await two.expectAnswered(first, `first-${word}`)
      await two.expectAnswered(second, `second-${word}`)
    })

    await step("Tab 1 asks again: it leads again, and doesn't send its old copy of the first question", async () => {
      await one.send(third)
      for (const tab of [two, b]) await tab.expectAnswered(third, `third-${word}`)
      const thread = await expectSameThread([two, b], word, 6)
      expect(pairs(thread).map(([asked]) => asked.text)).toEqual([first, second, third])
      expect(posts([one, two], first).map(({ status }) => status), "the first question was posted once").toEqual([202])
      expect(await storedQuestions(request, word)).toEqual([first, second, third])
    })

    await step("Tab 1 shows the same conversation", () => expectSameThread([one, two], word, 6))
  })

  test("taken back before it is sent: Edit in one tab takes a question out of the outbox another tab leads; it is never sent", {
    annotation: {
      type: "summary",
      description: "Tab 2 leads the outbox holding tab 1's question; Edit in tab 1 takes it back first, so it never reaches Postgres or B.",
    },
  }, async ({ devices, request }) => {
    requires("liveModel")
    const word = devices.word
    const [one, b] = await devices.open("Tab 1", "B")
    const two = await devices.tab(one.device, "Tab 2")
    const typo = question(`tpyo-${word}`)
    const fixed = question(`fixed-${word}`)

    await step("A goes offline; tab 1 asks, and its question waits", async () => {
      await one.offline()
      await one.ask(typo)
      await one.expectQueued(typo)
    })

    await step("Tab 2 opens its composer: it takes the outbox's lead, with tab 1's question in it", async () => {
      await two.openComposer()
      await two.expectQueued(typo)
    })

    await step("Tab 1: Edit takes the question back from the outbox, into its composer", async () => {
      await one.question(typo).hover()
      await one.question(typo).getByRole("button", { name: "Edit", exact: true }).click()
      await expect(one.composer).toHaveValue(typo)
      await expect(one.question(typo), "the question left tab 1").toHaveCount(0)
    })

    // Tab 2 still shows it queued until it leads again: the next test, marked broken.
    await step("Tab 1 sends the fixed question, and A comes back: only the fixed one reaches Postgres and B", async () => {
      await one.composer.fill(fixed)
      await one.composer.press("Enter")
      await one.online()
      await b.expectAnswered(fixed, `fixed-${word}`)
      await expect(b.question(typo), "B never shows the question taken back").toHaveCount(0)
      expect(posts([one, two], typo), "the question taken back never reached ChatApi").toEqual([])
      expect(await storedQuestions(request, word)).toEqual([fixed])
    })

    await step("Tab 1 shows its fixed question answered", () => one.expectAnswered(fixed, `fixed-${word}`))
  })

  test("taken back, still shown in the other tab: a question Edit took back in one tab stays Queued in the tab that led the outbox", {
    annotation: [
      {
        type: "summary",
        description: "Broken: Edit in tab 1 takes back a question tab 2's outbox held; tab 2 keeps showing it Queued, though it will never be sent.",
      },
      { type: "broken", description: BROKEN_GHOST },
    ],
  }, async ({ devices }) => {
    const word = devices.word
    const [one] = await devices.open("Tab 1")
    const two = await devices.tab(one.device, "Tab 2")
    const typo = question(`ghost-${word}`)

    await step("A goes offline; tab 1 asks, and tab 2 takes the outbox's lead with the question in it", async () => {
      await one.offline()
      await one.ask(typo)
      await two.openComposer()
      await two.expectQueued(typo)
    })

    await step("Tab 1: Edit takes the question back", async () => {
      await one.question(typo).hover()
      await one.question(typo).getByRole("button", { name: "Edit", exact: true }).click()
      await expect(one.composer).toHaveValue(typo)
      await expect(one.question(typo)).toHaveCount(0)
    })

    await step("Tab 2 shows it no more", async () => {
      // Marked here, so a failure before this line stays a failure.
      test.fail(true, BROKEN_GHOST)
      await expect(two.question(typo), "tab 2 no longer shows a question that will never be sent").toHaveCount(0, { timeout: 10_000 })
    })
  })

  test("taken back after ChatApi took it: Edit takes back a question Postgres already has, so it is both in the composer and answered", {
    annotation: [
      {
        type: "summary",
        description: "Broken: ChatApi took A's question but A hasn't seen it arrive; Edit still takes it back, so it is in the composer and answered.",
      },
      {
        type: "broken",
        description: "Outbox.withdraw takes back a write whose send reached the server and is waiting to be sent again (decision 0002 §3: never both)",
      },
    ],
  }, async ({ devices, request }) => {
    requires("faults", "liveModel")
    const word = devices.word
    const [[a], [b]] = await Promise.all([devices.openFaulty("A"), devices.open("B")])
    const asked = question(`twice-${word}`)

    await step("A's sync goes down, and A asks: ChatApi takes it (202), and B shows it answered", async () => {
      await a.device.syncDown()
      await a.askAndWaitTaken(asked)
      await b.expectAnswered(asked, `twice-${word}`)
    })

    await step("A goes offline before it sees its question arrive: the question still waits on A", async () => {
      await a.offline()
      await a.expectQueued(asked)
    })

    await step("A: Edit takes the question back into the composer", async () => {
      await expect(async () => {
        await a.question(asked).hover()
        await a.question(asked).getByRole("button", { name: "Edit", exact: true }).click()
        await expect(a.composer).toHaveValue(asked, { timeout: 2_000 })
      }).toPass({ timeout: 60_000 })
    })

    await step("A comes back: its question is in Postgres, answered, and still in its composer", async () => {
      await a.online()
      await a.device.syncUp()
      const retry = a.pill.getByRole("button", { name: "Retry" })
      if (await retry.isVisible()) await retry.click()
      await a.expectAnswered(asked, `twice-${word}`)
      expect(await storedQuestions(request, word)).toEqual([asked])
      // Decision 0002 §3: a write is taken back before it is sent, or sent and not taken back, never both. Marked here,
      // so a failure before this line stays a failure.
      test.fail(true, BROKEN_WITHDRAW)
      await expect(a.composer, "a question Postgres has is not also back in the composer").not.toHaveValue(asked)
    })
  })

  test("new build refuses a parked answer: an answer whose run the app's next build can't resume ends Couldn't answer on both devices, and Retry answers it", {
    annotation: {
      type: "summary",
      description: "A's answer was parked when a new build shipped that can't resume it: it ends Couldn't answer on both devices, and Retry answers.",
    },
  }, async ({ devices, request }) => {
    requires("faults", "liveModel")
    const word = devices.word
    const [[a], [b]] = await Promise.all([devices.openFaulty("A"), devices.open("B")])
    const asked = question(`build-${word}`)

    await step("A asks; the app's next build can't resume the run answering it (payload_changed)", async () => {
      await faults(a.page).engine.refuseResults("chat/Answer", "payload_changed")
      await a.askAndWaitTaken(asked)
    })

    await step("The answer ends Couldn't answer on both devices, with Retry", async () => {
      for (const tab of [a, b]) await tab.expectFailed(asked)
    })

    await step("A opens the new build and presses Retry: asked again, and answered on both devices", async () => {
      await reopen(a, false)
      await a.expectFailed(asked)
      await a.answerTo(asked).getByRole("button", { name: "Retry", exact: true }).click()
      const thread = await expectSameThread([a, b], word, 4)
      const [failed, answered] = pairs(thread)
      expect(failed![1].text).toBe(COULDNT_ANSWER)
      expect(answered![0].text).toBe(asked)
      expect(answered![1].text).toContain(`build-${word}`)
    })

    const rows = await serverRows(request, word)
    expect(rows.map(({ role, status }) => `${role} ${status}`)).toEqual(["user done", "assistant failed", "user done", "assistant done"])
  })

  test("clock skew: a device whose clock is a day behind still takes its place by when Postgres got its question", {
    annotation: {
      type: "summary",
      description: "A's clock is a day behind: its offline question still shows last, and lands after B's, by when Postgres got it.",
    },
  }, async ({ devices, request }) => {
    requires("liveModel")
    const word = devices.word
    const [a, b] = await devices.open("A", "B")
    await step("A's clock is a day behind", async () => {
      // Playwright's clock sets the device's clock: approved for the clock tests only (TEST-12).
      await a.page.clock.install({ time: Date.now() - DAY })
      await reopen(a)
    })
    const fromA = question(`behind-${word}`)
    const fromB = question(`ontime-${word}`)

    await step("A asks offline: its question shows last, after everything A has, whatever its clock says", async () => {
      await a.offline()
      await a.ask(fromA)
      await a.expectQueued(fromA)
      expect((await a.transcript()).at(-1)?.text).toBe(fromA)
    })

    await step("B asks meanwhile, and is answered", async () => {
      await b.ask(fromB)
      await b.expectAnswered(fromB, `ontime-${word}`)
    })

    await step("A comes back: its question goes after B's on both devices, as Postgres got them", async () => {
      await a.online()
      await a.expectAnswered(fromA, `behind-${word}`)
      const thread = await expectSameThread([a, b], word, 4)
      expect(pairs(thread).map(([asked]) => asked.text)).toEqual([fromB, fromA])
    })

    expect(await storedQuestions(request, word)).toEqual([fromB, fromA])
  })

  test("clock steps back: two questions asked offline, with the device's clock set back an hour between them, reach Postgres out of order", {
    annotation: [
      {
        type: "summary",
        description: "Broken: A's clock steps back an hour between two offline questions: A shows the second one twice, and its outbox orders them by that clock.",
      },
      {
        type: "broken",
        description: BROKEN_CLOCK,
      },
    ],
  }, async ({ devices, request }) => {
    requires("liveModel")
    const word = devices.word
    const [a, b] = await devices.open("A", "B")
    // Playwright's clock sets the device's clock: approved for the clock tests only (TEST-12).
    await a.page.clock.install()
    await reopen(a)
    const first = question(`early-${word}`)
    const second = question(`late-${word}`)

    await step("A asks offline", async () => {
      await a.offline()
      await a.ask(first)
    })

    await step("A's clock steps back an hour, and A asks again: A shows both, in the order asked", async () => {
      await a.page.clock.setSystemTime(Date.now() - HOUR)
      // Marked here, so a failure before this line stays a failure.
      test.fail(true, BROKEN_CLOCK)
      await a.send(second)
      await expect.poll(async () => (await a.thread(word)).map(({ text }) => text)).toEqual([first, second])
    })

    await step("A comes back: Postgres and B have them in the order A asked", async () => {
      await a.online()
      await expect.poll(() => storedQuestions(request, word), { timeout: 60_000 }).toEqual([first, second])
      const thread = await expectSameThread([a, b], word, 4)
      expect(pairs(thread).map(([asked]) => asked.text)).toEqual([first, second])
    })
  })
})

// --- TODOs (decision 0016): the stack of a public repository; nothing is written to GitHub ---

const STACK = "octocat/Spoon-Knife"

const todoRow = (tab: Tab, word: string) =>
  tab.page.getByRole("region", { name: `${STACK} stack` }).locator("[data-slot=issues-row]", { hasText: word })

const openStack = (tab: Tab) =>
  step(`${tab.name} opens the stack`, async () => {
    await tab.page.goto(`/${STACK}/stack`)
    await expect(tab.page.getByRole("region", { name: `${STACK} stack` })).toBeVisible({ timeout: 60_000 })
  })

/** Drops TODO `number` from its row's menu, confirming once. */
const drop = (tab: Tab, word: string, number: string) =>
  step(`${tab.name} drops T${number}`, async () => {
    await todoRow(tab, word).getByRole("button", { name: `T${number} actions` }).click()
    await tab.page.getByRole("menuitem", { name: "Drop" }).click()
    await tab.page.getByRole("dialog", { name: `Drop T${number}?` }).getByRole("button", { name: "Drop", exact: true }).click()
  })

/** The TODO has left the Open list and shows Dropped in the Closed one. */
const expectDropped = async (tab: Tab, word: string) => {
  await expect(todoRow(tab, word), `${tab.name}: it left the Open list`).toHaveCount(0, { timeout: 60_000 })
  await tab.page.getByRole("navigation", { name: "Filter" }).getByRole("link", { name: /Closed/ }).click()
  await expect(todoRow(tab, word), `${tab.name}: Dropped, once`).toHaveCount(1, { timeout: 60_000 })
  await expect(todoRow(tab, word)).toHaveAttribute("data-status", "dropped")
}
