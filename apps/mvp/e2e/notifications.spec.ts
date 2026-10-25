import { createHmac, randomBytes } from "node:crypto"
import { expect, type Tab, test } from "./devices"
import { requires, scriptedAgent } from "./target"

// Notifications and live work, end to end (decision 0009, docs/features/notifications.md): two people, Ann on two
// devices and Ben on one, in real browsers against the real app, ChatApi, Postgres and Electric. Ann's agent is the
// scripted one in her first device's engine worker (`/app?agent=needs-you`, src/test/scriptedAgent.ts), so its run
// asks her a question every time; everything else is real. Ben is local development's second person
// (`smithers_dev_person=teammate`, worker/DevChatApi.ts); both open the home conversation, so both are on `main`.

const PROMPT = "Which branch should I deploy?"

/**
 * How long another device takes to show a change. Every shape's long poll waits at Electric at once over HTTP/2, which
 * the dev server speaks as production does (docs/infrastructure.md#https-and-http2), so a change comes back with the
 * next response.
 */
const SYNCED_WITHIN = 15_000

/** The stack on `tab`: the inline one over the home conversation, or the page stack. */
const stack = (tab: Tab) => tab.page.getByRole("region", { name: "Smithers" })

/** The toast about `subject` on `tab`. */
const entry = (tab: Tab, subject: string) => stack(tab).locator(`[data-slot="toast"][data-subject="${subject}"]`)

/** The notifications panel on `tab`. */
const panel = (tab: Tab) => tab.page.getByRole("dialog", { name: "Notifications" })

/** The header's bell, which opens and closes the panel. */
const bell = (tab: Tab) => tab.page.getByRole("button", { name: /^Notifications/ })

/** The panel's entry about `subject` on `tab`. */
const notification = (tab: Tab, subject: string) =>
  panel(tab).locator(`[data-slot="notification"][data-entry="${subject}"]`)

/** A key pressed on `tab`, as its own chapter of the video. */
const press = (tab: Tab, key: string, label: string) =>
  test.step(`${tab.name}: ${label} (${key})`, () => tab.page.keyboard.press(key))

/**
 * Checks `check` on `tab` with the panel open, opening it from the bell whenever it is closed: under the dev server,
 * another change to the app's sources reloads the page, and a reloaded panel starts closed.
 */
const inPanel = (tab: Tab, check: () => Promise<void>, timeout = SYNCED_WITHIN) =>
  expect(async () => {
    if (!(await panel(tab).isVisible())) await bell(tab).click()
    await check()
  }).toPass({ timeout, intervals: [250, 500, 1_000] })

test("live work: Ann's run toasts for Ben on her branch, and her notifications follow her across devices", async ({ devices }) => {
  requires("scriptedAgent", "devPeople")
  test.setTimeout(480_000)
  const word = devices.word
  const [a1, a2] = await devices.open("Ann", "Ann 2")
  const [b] = await devices.openTeammate("Ben")
  // Ben leaves the conversation for the Runs page: Ann's work on `main` reaches him there.
  await b.page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Runs" }).click()
  await expect(b.page.getByRole("main", { name: "Runs" })).toBeVisible()
  await a1.page.goto(scriptedAgent("needs-you"))
  await a1.ready()

  const question = `Deploy the docs preview, ${word}`
  await a1.askAndWaitTaken(question)
  const answerId = a1.asked.find((asked) => asked.text === question)!.answerId
  const subject = `run:${answerId}`

  // Ann's agent asks her: a gold toast with Answer on both her devices.
  for (const tab of [a1, a2]) {
    await expect(entry(tab, subject), `${tab.name}: Ann's question toasts`).toContainText(`Needs you · ${PROMPT}`, {
      timeout: 120_000,
    })
    await expect(entry(tab, subject).getByRole("button", { name: "Answer" })).toBeVisible()
  }
  // Ben, on another page, sees her run waiting, named, in the page stack, with no Answer of his own.
  await expect(stack(b)).toHaveAttribute("data-placement", "inline")
  await expect(entry(b, subject), "Ben: Ann's run on his branch toasts").toContainText("Waiting · local-developer", {
    timeout: SYNCED_WITHIN,
  })
  await expect(entry(b, subject)).toContainText(word)
  await expect(entry(b, subject).getByRole("button", { name: "Answer" })).toHaveCount(0)
  // His top bar has the bell on this page too.
  await expect(bell(b)).toBeVisible()
  // Clicking the toast takes him to her run, in the conversation.
  await entry(b, subject).locator('[data-slot="toast-open"]').click()
  await expect(b.page).toHaveURL(new RegExp(`/app#${answerId}$`))
  await expect(b.page.locator(`[id="${answerId}"]`), "Ben: at her run").toBeInViewport()

  // Ann 2 hides the toast by key: Alt+T focuses it, H hides it on both devices; the entry stays in her list.
  await press(a2, "Alt+KeyT", "focus the toast")
  await expect(entry(a2, subject).locator('[data-slot="toast-open"]')).toBeFocused()
  await press(a2, "h", "hide it")
  try {
    await Promise.all([a1, a2].map((tab) =>
      expect(entry(tab, subject), `${tab.name}: hidden`).toHaveCount(0, { timeout: SYNCED_WITHIN })
    ))
  } catch (error) {
    const receipts = [a1, a2].map((tab) => {
      const lines = tab.log.filter((line) => /notifications\.(ack|pending)/.test(line)).slice(-30)
      return `${tab.name}: ${lines.length === 0 ? "no notifications.ack or notifications.pending records" : lines.join("\n")}`
    }).join("\n")
    throw new Error(`Hide did not reach both devices within 15 seconds.\n${receipts}\n${String(error)}`, { cause: error })
  }

  // Ann's top bar says a run waits on her. One click on it opens her notifications at that run, expanded with its
  // question; clicking the entry collapses it and again expands it; A focuses the field, and she answers there.
  await expect(bell(a1), "Ann: the top bar says she is needed").toContainText("Needs you")
  await inPanel(a1, async () => {
    await expect(notification(a1, subject), "Ann: in her list").toContainText(`Needs you · ${PROMPT}`, { timeout: 2_000 })
    await expect(notification(a1, subject)).toHaveAttribute("data-expanded", "", { timeout: 2_000 })
    await expect(notification(a1, subject).getByRole("button", { name: "docs-v2" })).toBeVisible({ timeout: 2_000 })
  })
  await notification(a1, subject).locator('[data-slot="notification-row"]').click()
  await expect(notification(a1, subject)).not.toHaveAttribute("data-expanded", "")
  await notification(a1, subject).locator('[data-slot="notification-row"]').click()
  await expect(notification(a1, subject).getByRole("button", { name: "docs-v2" })).toBeVisible()
  await notification(a1, subject).locator('[data-slot="notification-row"]').focus()
  await press(a1, "a", "answer")
  const field = notification(a1, subject).getByRole("textbox", { name: "Your answer" })
  await expect(field).toBeFocused()
  await field.fill("docs-v2")
  await field.press("Enter")
  await a1.expectAnswered(question, "Deploying docs-v2.", 120_000)

  // Done: Ben's toast settles and goes by itself (4 s after the run finished; the rule is src/features/attention's
  // tests'); it never joins his list.
  await expect(entry(b, subject), "Ben: it goes once the run is done").toHaveCount(0, { timeout: SYNCED_WITHIN })
  await inPanel(b, () => expect(notification(b, subject), "Ben: never in his list").toHaveCount(0, { timeout: 2_000 }))

  // Ann 2: Alt+N opens her notifications; the run is done and unread, newest first. R reads it on both devices, E
  // expands it to the answer, and O opens it there.
  await press(a2, "Alt+KeyN", "open notifications")
  await expect(panel(a2)).toBeVisible()
  await expect(notification(a2, subject), "Ann 2: done, unread").toContainText("Done", { timeout: SYNCED_WITHIN })
  await expect(notification(a2, subject)).toHaveAttribute("data-unread", "")
  await notification(a2, subject).locator('[data-slot="notification-row"]').focus()
  await press(a2, "r", "mark it read")
  for (const tab of [a1, a2]) {
    await inPanel(tab, () =>
      expect(notification(tab, subject), `${tab.name}: read`).not.toHaveAttribute("data-unread", "", { timeout: 2_000 })
    )
  }
  await notification(a2, subject).locator('[data-slot="notification-row"]').focus()
  await press(a2, "e", "expand it")
  await expect(notification(a2, subject).locator('[data-slot="notification-body"]')).toContainText("Deploying docs-v2.")
  await press(a2, "o", "open it")
  await expect(panel(a2)).toHaveCount(0)
  await expect(a2.page).toHaveURL(new RegExp(`/app#${answerId}$`))

  // Ann: the bell opens her notifications; Dismiss closes the entry on both devices.
  await expect(async () => {
    if (await panel(a1).isVisible()) await a1.page.keyboard.press("Escape")
    await bell(a1).click({ timeout: 2_000 })
    await notification(a1, subject).getByRole("button", { name: "Dismiss" }).click({ timeout: 2_000 })
  }).toPass({ timeout: SYNCED_WITHIN, intervals: [250, 500, 1_000] })
  for (const tab of [a1, a2]) {
    await inPanel(tab, () => expect(notification(tab, subject), `${tab.name}: dismissed`).toHaveCount(0, { timeout: 2_000 }))
  }
})

// GitHub's deliveries need the deployment's webhook secret, which only a deployment with the GitHub App configured
// has: this test signs them as GitHub does, with E2E_GITHUB_WEBHOOK_SECRET, the dev server's GITHUB_WEBHOOK_SECRET.
// It writes a `main` entry for everyone watching the repository, so it runs only against local development.
const secret = process.env.E2E_GITHUB_WEBHOOK_SECRET

test("repository events: `main` moving and a new release reach both people as entries", async ({ devices }) => {
  requires("webhookSecret", "devPeople")
  test.setTimeout(180_000)
  const repository = process.env.GITHUB_REPOSITORY ?? "smithersai/smithers"
  const [a] = await devices.open("Ann")
  const [b] = await devices.openTeammate("Ben")
  const sha = randomBytes(20).toString("hex")
  const tag = `v0.0.0-${devices.word}`
  const deliver = async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload)
    const response = await a.page.request.post("/api/github/webhook", {
      data: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret!).update(body).digest("hex")}`,
      },
    })
    expect(response.status(), `GitHub's ${event} delivery is taken`).toBe(200)
  }
  await deliver("push", {
    ref: "refs/heads/main",
    after: sha,
    repository: { full_name: repository, default_branch: "main", pushed_at: Math.floor(Date.now() / 1000) },
    head_commit: { message: `Ship ${devices.word}` },
    pusher: { name: "dana" },
  })
  await deliver("release", {
    action: "published",
    release: { tag_name: tag, name: `Release ${devices.word}`, published_at: new Date().toISOString() },
    repository: { full_name: repository },
  })
  const [owner, name] = repository.toLowerCase().split("/")
  for (const tab of [a, b]) {
    await inPanel(tab, async () => {
      await expect(notification(tab, `main:github/${owner}/${name}`)).toContainText(
        `main · ${sha.slice(0, 7)} Ship ${devices.word}`,
        { timeout: 2_000 },
      )
      await expect(notification(tab, `release:github/${owner}/${name}:${tag}`)).toContainText(
        `Release · Release ${devices.word}`,
        { timeout: 2_000 },
      )
    })
  }
  // Expanded, main says who pushed; Open takes Ben to the repository.
  await notification(b, `main:github/${owner}/${name}`).locator('[data-slot="notification-row"]').click()
  await expect(notification(b, `main:github/${owner}/${name}`).locator('[data-slot="notification-body"]')).toContainText("dana")
  await notification(b, `main:github/${owner}/${name}`).getByRole("button", { name: "Open" }).click()
  await expect(b.page).toHaveURL(new RegExp(`/${owner}/${name}$`, "i"))
})

test("live notification: own-branch toast opens, expands and dismisses across two devices", {
  annotation: { type: "summary", description: "A real agent asks a question; its toast opens the run and dismissal syncs to another device." },
}, async ({ devices }) => {
  requires("member", "ownConversation", "liveModel")
  test.setTimeout(300_000)
  const [a, b] = await devices.open("Laptop", "Phone")
  const prompt = `Choose a proof label ${devices.word}`
  const question = `Use app/agent/ask to ask me the question "${prompt}" with options "Blue" and "Green". Wait for my reply before continuing. After I answer, reply "Received ${devices.word}".`
  await a.askAndWaitTaken(question)
  const answerId = a.asked.find((asked) => asked.text === question)!.answerId
  const subject = `run:${answerId}`
  try {
    for (const tab of [a, b]) {
      await expect(entry(tab, subject)).toContainText(prompt, { timeout: 120_000 })
    }
    await entry(b, subject).locator('[data-slot="toast-open"]').click()
    await expect(b.page).toHaveURL(new RegExp(`#${answerId}$`))
    await expect(b.page.locator(`[id="${answerId}"]`)).toBeInViewport()
    await inPanel(b, () => expect(notification(b, subject)).toContainText(prompt, { timeout: 2_000 }))
    const item = notification(b, subject)
    // The bell may already expand the waiting question. Collapse, then click to prove expansion.
    if (await item.getAttribute("data-expanded") !== null) await item.locator('[data-slot="notification-row"]').click()
    await expect(item).not.toHaveAttribute("data-expanded", "")
    await item.locator('[data-slot="notification-row"]').click()
    await expect(item).toHaveAttribute("data-expanded", "")
    await expect(item.getByRole("button", { name: "Blue", exact: true })).toBeVisible()
    await item.getByRole("button", { name: "Blue", exact: true }).click()
    await a.expectAnswered(question, `Received ${devices.word}`, 120_000)
    await inPanel(b, () => expect(notification(b, subject)).toContainText("Done", { timeout: 2_000 }))
    await notification(b, subject).getByRole("button", { name: "Dismiss", exact: true }).click()
    for (const tab of [a, b]) {
      await inPanel(tab, () => expect(notification(tab, subject)).toHaveCount(0, { timeout: 2_000 }))
      await expect(entry(tab, subject)).toHaveCount(0)
    }
    await b.reload()
    await inPanel(b, () => expect(notification(b, subject)).toHaveCount(0, { timeout: 2_000 }))
  } finally {
    // If an assertion fails while the real agent waits, answer it rather than leaving a human task behind.
    await inPanel(a, async () => {
      const item = notification(a, subject)
      if (await item.count() === 0) return
      if (await item.getAttribute("data-expanded") === null) await item.locator('[data-slot="notification-row"]').click()
      const choice = item.getByRole("button", { name: "Blue", exact: true })
      if (await choice.isVisible()) await choice.click()
    }).catch(() => undefined)
  }
})
