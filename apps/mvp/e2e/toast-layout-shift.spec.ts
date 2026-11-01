import type { Locator, Page } from "@playwright/test"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract"
import { expect, type Tab, test } from "./devices"
import { requires } from "./target"

// Will, 2026-10-31: "when we get notifications it pushes the rest of the content on the page down which is janky"
// (ruling FE-21). A toast overlays the page under its header and takes no layout space (decision 0137): while a notice
// arrives and leaves through the feed's real path, the conversation, the composer, a branch page's view and the headers
// keep their boxes, and the browser records no layout shift outside the conversation's own messages and the header's
// own status. A run in a conversation Ann isn't looking at reports through ChatApi's runs route, which folds the
// notice that Electric syncs to her (decision 0009); her Hide acks it. On the chat page it is her own run in a branch
// she tracks; on a branch page it is the run of Ben, local development's teammate, on `main`, which she follows.
// Another conversation's run, because over a conversation its own runs show in the conversation instead unless they
// need you (src/features/attention/entries.ts `stackHere`), and a run that needs its person also changes the header's
// own bell, which is 0015's business, not the toast's. Fails on the stack that sat in the page's flow, which took a
// row of its own for each toast.

requires("member", "homeConversation", "devPeople")

/** The question's box, in a few words; the toast carries it. */
const ASK = "Which branch should I deploy?"

type Box = { x: number; y: number; width: number; height: number }

/** Each watched element's box, by name. */
const boxesOf = async (watched: Record<string, Locator>): Promise<Record<string, Box>> => {
  const boxes: Record<string, Box> = {}
  for (const [name, locator] of Object.entries(watched)) {
    const box = await locator.boundingBox()
    if (box === null) throw new Error(`${name} has no visible box`)
    boxes[name] = box
  }
  return boxes
}

/**
 * Starts recording the page's layout shifts (`PerformanceObserver`'s `layout-shift` entries; WebKit has none, and says
 * so). A shift counts when one of its sources is outside the conversation's own transcript (its scroller and its
 * messages, where a run's card arrives as content and the transcript lays itself out), outside the toast stack
 * itself, and outside the header's status, which the run's state changes by design (decision 0015).
 */
const watchShifts = (page: Page) =>
  page.evaluate(() => {
    type Shift = { value: number; sources: Array<string> }
    type LayoutShift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node: Node | null }> }
    const shifts: Array<Shift> = []
    const supported = PerformanceObserver.supportedEntryTypes.includes("layout-shift")
    Object.assign(window, { __shifts: shifts, __shiftsSupported: supported })
    if (!supported) return
    const own = '.sui-msg-scroller, .sui-chat-messages, [data-slot="toast-stack"], .app-shell-header, header[aria-label="Repository"]'
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<LayoutShift>) {
        const sources = (entry.sources ?? [])
          .map((source) => source.node)
          .filter((node): node is Element => node instanceof Element)
          .filter((node) => node.closest(own) === null)
          .map((node) => `${node.tagName.toLowerCase()}${typeof node.className === "string" && node.className !== "" ? `.${node.className.trim().split(/\s+/).join(".")}` : ""}`)
        if (sources.length > 0) shifts.push({ value: entry.value, sources })
      }
    }).observe({ type: "layout-shift", buffered: false })
  })

/** The shifts recorded since `watchShifts`, or `null` where the browser records none. */
const shiftsSeen = (page: Page) =>
  page.evaluate(() => {
    const window_ = window as unknown as { __shifts?: Array<{ value: number; sources: Array<string> }>; __shiftsSupported?: boolean }
    return window_.__shiftsSupported === true ? window_.__shifts ?? [] : null
  })

/** Local development's people (worker/DevChatApi.ts): the developer `devices.open` opens as, and the teammate. */
const DEVELOPER = "local-developer"
const TEAMMATE = "local-teammate"

/**
 * Posts `data` to `path` from `tab`'s own page, as the app does: the request carries its person's cookie (local
 * development's people are a cookie, worker/DevChatApi.ts) and, as every cookie-signed write must, the device's
 * person (`DEVICE_PERSON_HEADER`, worker/RunCredentials.ts `resolveWith`); fails with the body when the route
 * refuses it.
 */
const post = async (tab: Tab, person: string, path: string, data: unknown) => {
  const refused = await tab.page.evaluate(async ([path, body, header, person]) => {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", [header]: person }, body })
    return response.ok ? null : `${response.status} ${await response.text()}`
  }, [path, JSON.stringify(data), DEVICE_PERSON_HEADER, person] as const)
  expect(refused, `${tab.name}: ${path}`).toBeNull()
}

/**
 * The fixture repository, public `octocat/Spoon-Knife`, whose branches GitHub already has; nothing is written to
 * GitHub. Ann, local development's developer, opens `test-branch` as the other specs have her do, and tracks
 * `change-the-title` for the conversation her run elsewhere reports in.
 */
const REPO = { owner: "octocat", name: "Spoon-Knife" }
const BRANCH = "test-branch"
const ELSEWHERE = "change-the-title"

/**
 * Ann tracks `ref` through the branches route a branch page calls (worker/branch/Branches.ts, decision 0013 §2), and
 * so has that branch's conversation to ask in: a branch is its tracker's to edit, and nobody else's to watch.
 */
const track = (ann: Tab, ref: string) =>
  test.step(`Ann: tracks ${ref}`, async () => {
    const tracked = await ann.page.evaluate(async ([body, header, person]) => {
      const response = await fetch("/api/branches", { method: "POST", headers: { "content-type": "application/json", [header]: person }, body })
      return response.ok ? ((await response.json()) as { readonly conversationId: string }).conversationId : `${response.status} ${await response.text()}`
    }, [JSON.stringify({ ...REPO, ref }), DEVICE_PERSON_HEADER, DEVELOPER] as const)
    expect(tracked, "Ann: /api/branches").toMatch(/^[0-9a-f-]{36}$/)
    return tracked
  })

/**
 * Ann follows a conversation (`null`: `main`'s) through the watches route her tab's `watch/set` flow calls, so Ben's
 * run in it reaches her (worker/Notifications.ts routes a run to its branch's watchers at the moment it reports): the
 * tab sets it from its outbox in its own time, and this test must not race it.
 */
const follow = (ann: Tab, conversationId: string | null) =>
  test.step("Ann: follows the conversation", () => post(ann, DEVELOPER, "/api/watches", { conversationId }))

/**
 * `asker`, who is `person`, asks in `conversationId` (`null`: `main`'s home conversation); `report` makes the run
 * report `working`, so Ann's feed gains the notice, and `settle` ends it.
 */
const ask = async (asker: Tab, person: string, word: string, conversationId: string | null) => {
  const id = crypto.randomUUID()
  const answerId = crypto.randomUUID()
  await post(asker, person, "/api/questions", { id, answerId, text: `${ASK} ${word}`, ...(conversationId === null ? {} : { conversationId }) })
  return {
    answerId,
    report: () => post(asker, person, `/api/runs/${answerId}`, { status: "working" }),
    // Ends the run and clears the asker's own entry: housekeeping, outside the page's watched network, never an assertion.
    settle: async () => {
      const headers = { [DEVICE_PERSON_HEADER]: person }
      await asker.page.request.post(`/api/answers/${answerId}`, { headers, data: { status: "failed", failure: "unfinished" } })
      await asker.page.request.post("/api/notifications/ack", { headers, data: { subject: `run:${answerId}`, version: 2, act: "dismiss" } })
    },
  }
}

/** The toast about `answerId` on `tab`, in the page's one stack. */
const toastOf = (tab: Tab, answerId: string) =>
  tab.page.getByRole("region", { name: "Smithers", exact: true }).locator(`[data-slot="toast"][data-run="${answerId}"]`)

/**
 * Proves the toast about `answerId` arrives and leaves without moving `watched`: their boxes before, while it shows,
 * and after Hide are the same, the toast hangs under `header`'s box, and no layout shift reached the page.
 */
const expectNoShift = async (
  ann: Tab,
  asked: { readonly answerId: string; readonly report: () => Promise<void> },
  watched: Record<string, Locator>,
  header: Locator,
) => {
  const page = ann.page
  await watchShifts(page)
  // The page's own content still arriving (a branch page's files from GitHub, another test's toast for the same Ann)
  // is not under test: measure from a quiet page, one whose boxes and shifts held for 1.5 s.
  const before = await test.step("Ann: the page is quiet", async () => {
    let boxes = await boxesOf(watched)
    await expect.poll(async () => {
      const shifts = (await shiftsSeen(page))?.length ?? 0
      await page.waitForTimeout(1_500)
      const now = await boxesOf(watched)
      const quiet = ((await shiftsSeen(page))?.length ?? 0) === shifts && JSON.stringify(now) === JSON.stringify(boxes)
      boxes = now
      return quiet
    }, { timeout: 60_000, intervals: [100] }).toBe(true)
    await page.evaluate(() => { (window as unknown as { __shifts: Array<unknown> }).__shifts.length = 0 })
    return boxes
  })
  const toast = toastOf(ann, asked.answerId)
  await test.step("Ben's run reports; Ann: the notice arrives", async () => {
    await asked.report()
    await expect(toast).toBeVisible({ timeout: 60_000 })
    // It has fully arrived once its entrance ends: the fade and slide are opacity and transform only.
    await expect.poll(() => toast.evaluate((element) => Number(getComputedStyle(element).opacity)), { timeout: 5_000 }).toBe(1)
  })
  const during = await boxesOf(watched)
  expect(during, "nothing moved while the toast showed").toEqual(before)
  // The stack's box, not the toast's: another notice for the same Ann may sit above it in the stack.
  const stackBox = (await toast.locator('xpath=ancestor::*[@data-slot="toast-stack"][1]').boundingBox())!
  const headerBox = (await header.boundingBox())!
  expect(stackBox.y, "the stack hangs under the header").toBeGreaterThanOrEqual(headerBox.y + headerBox.height)
  expect(stackBox.x + stackBox.width, "the stack keeps to the header's width").toBeLessThanOrEqual(headerBox.x + headerBox.width + 1)
  // A header scrolled offscreen cannot bound a visible overlay. Clearance then
  // picks a visible free gap; an on-screen anchor still keeps the stack nearby.
  if (headerBox.y + headerBox.height >= 0) {
    expect(stackBox.y, "the stack sits right under the header, not at the window's foot").toBeLessThan(headerBox.y + headerBox.height + 48)
  }
  await expect(toast).toBeInViewport({ ratio: 1 })
  await test.step("Ann: hides it", async () => {
    await toast.getByRole("button", { name: "Hide", exact: true }).click()
    await expect(toast).toHaveCount(0, { timeout: 30_000 })
  })
  const after = await boxesOf(watched)
  expect(after, "nothing moved when the toast left").toEqual(before)
  const shifts = await shiftsSeen(page)
  if (shifts !== null) expect(shifts, "no layout shift reached the page").toEqual([])
}

for (const width of [1280, 390]) {
  test(`chat at ${width}px: a notice arrives and leaves without moving the conversation or the composer`, {
    annotation: { type: "summary", description: "A toast overlays the chat under its header; the page never moves." },
  }, async ({ devices }) => {
    test.setTimeout(240_000)
    const [ann] = await devices.open("Ann")
    await ann.page.setViewportSize({ width, height: 800 })
    const main = ann.page.getByRole("main", { name: "App" })
    const watched = {
      header: main.locator(".app-shell-header"),
      // The conversation's section: the column under the header, which the transcript inside scrolls.
      conversation: main.locator(".app-shell-conversation"),
      composer: main.locator(".app-shell-composer"),
    }
    // Her own run in another branch's conversation: a notice about work elsewhere, the kind that toasts over the
    // conversation she is looking at (a run in it shows in it instead). Her own, because a branch's conversation is
    // its tracker's alone to ask in and to watch.
    const conversationId = await track(ann, ELSEWHERE)
    const asked = await ask(ann, DEVELOPER, devices.word, conversationId)
    try {
      // ComposerGate waits for the session and model rows. Measure the settled page, not that initial loading gap.
      await expect(watched.composer.locator(":scope > *").first()).toBeVisible({ timeout: 60_000 })
      await expectNoShift(ann, asked, watched, watched.header)
    } finally {
      await asked.settle()
    }
  })

  test(`branch page at ${width}px: a notice arrives and leaves without moving the view, the conversation or the composer`, {
    annotation: { type: "summary", description: "A toast overlays a branch page under its chrome; the page never moves." },
  }, async ({ devices }) => {
    test.setTimeout(240_000)
    const [ann] = await devices.open("Ann")
    const [ben] = await devices.openTeammate("Ben")
    await ann.page.setViewportSize({ width, height: 800 })
    await test.step("Ann: opens a branch", async () => {
      await ann.page.goto(`/${REPO.owner}/${REPO.name}/tree/${BRANCH}`)
      await expect(ann.page.getByRole("navigation", { name: "Branch" })).toContainText(BRANCH, { timeout: 60_000 })
      // The workspace: the view beside the conversation, whatever the view holds (files, Not cloned, or GitHub's limit).
      await expect(ann.page.locator(".branch-screen-view")).toBeVisible({ timeout: 60_000 })
      await expect(ann.page.locator(".branch-screen-conversation")).toBeVisible({ timeout: 60_000 })
      await expect(ann.page.locator(".branch-screen-composer")).toBeVisible({ timeout: 60_000 })
    })
    const main = ann.page.getByRole("main", { name: "Repository" })
    const watched = {
      repository: main.locator('header[aria-label="Repository"]'),
      branch: ann.page.getByRole("navigation", { name: "Branch" }),
      view: main.locator(".branch-screen-view"),
      // The conversation's card: the column beside the view, with the composer at its foot.
      conversation: main.locator(".branch-screen-conversation"),
      composer: main.locator(".branch-screen-composer"),
    }
    // Ben's run on `main`, which Ann follows from the branch's page.
    await follow(ann, null)
    const asked = await ask(ben, TEAMMATE, devices.word, null)
    try {
      await expectNoShift(ann, asked, watched, watched.branch)
    } finally {
      await asked.settle()
    }
  })
}
