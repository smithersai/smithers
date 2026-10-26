import { CALLBACK_ROUTE, SIGN_IN, SIGN_IN_TO_ASK, SIGN_OUT } from "../src/features/auth/contract"
import { QUESTIONS_ROUTE, SHAPE_ROUTE } from "../src/features/chat/contract"
import type { Dialog, Page } from "@playwright/test"
import { faultyApp, faults } from "./faults"
import { expect, QUEUED, type Tab, test } from "./devices"
import { step, test as pageTest } from "./fixtures"
import { appHome, baseURL, me, requires, sessionFiles, signedOut } from "./target"
import { expectServerError } from "./watch"

// Sign-in, end to end (docs/features/sign-in.md): the real app, ChatApi and Postgres. Under `alchemy dev` without the
// GitHub App, a local developer is signed in as an Admin until they sign out, and "Sign in with GitHub" signs them in
// again without GitHub (`worker/DevChatApi.ts`): those tests run locally (`requires("devSignIn")`, e2e/target.ts). A
// deployment signs the test account in through GitHub once per run (e2e/deployment/sign-in.setup.ts), and every test
// shares that session, so none here signs out of it; "github" checks the deployment's half of signing in instead.

test("signed out: the composer is gated, ChatApi refuses an ask, and signing in brings the composer back", { annotation: { type: "summary", description: "Signed out, a person can't ask, the server refuses an ask, and signing in brings the composer back." } }, async ({ devices }) => {
  requires("devSignIn")
  const [a] = await devices.open("A")
  const page = a.page
  await expect(a.chatButton).toBeVisible({ timeout: 30_000 })

  // Sign out: the page continues as a visitor, with the sign-in prompt where the composer was.
  await page.getByRole("button", { name: SIGN_OUT }).click()
  await expect(page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })
  await expect(a.chatButton).toBeHidden()
  await page.keyboard.press("ControlOrMeta+k")
  await expect(a.composer).toBeHidden()

  // Nothing a signed-out page sends is taken: ChatApi refuses the ask itself, and writes nothing.
  const refused = await page.request.post(QUESTIONS_ROUTE, {
    data: { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: `signed out ${devices.word}` },
  })
  expect(refused.status()).toBe(401)

  // Sign in again: the button returns to this page, signed in, and the composer is back.
  await page.getByRole("link", { name: SIGN_IN }).first().click()
  await expect(a.chatButton).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(SIGN_IN_TO_ASK)).toBeHidden()
})

test("sign out wipes the device: its unsent questions go, and the conversation syncs again from scratch", { annotation: { type: "summary", description: "Signing out deletes the device's unsent questions, and the conversation syncs again from scratch." } }, async ({ devices }) => {
  requires("devSignIn", "faults")
  const word = devices.word
  const [a] = await devices.openFaulty("A")
  const page = a.page

  // A question ChatApi refused stays on the device, Not sent: the person's own data, kept in the device's store.
  await faults(page).questions.failNext("bad_request")
  const kept = `Never sent ${word}`
  await a.ask(kept)
  await a.expectNotSent(kept)

  // Sign out. The tab wipes the device's database, the engine's journal and the outbox, then opens as a visitor.
  // The shape requests of the page signing out opens as: a navigation starts the list over.
  const shapes: Array<URL> = []
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) shapes.length = 0
  })
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === SHAPE_ROUTE) shapes.push(url)
  })
  await page.getByRole("button", { name: SIGN_OUT }).click()
  await expect(page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })

  // The unsent question is gone, and the conversation's first request after signing out starts over (offset -1, no
  // handle): nothing the device stored for the session survived.
  await expect(a.question(kept)).toHaveCount(0)
  await expect.poll(() => shapes.length, { timeout: 30_000 }).toBeGreaterThan(0)
  expect(shapes[0]!.searchParams.get("offset")).toBe("-1")
  expect(shapes[0]!.searchParams.get("handle")).toBeNull()
  expect(await outboxSize(page), "the outbox holds nothing").toBe(0)
})

test("sign out wipes the device for every tab: a tab still holding the data holds the wipe off, and no tab opens on the session's data", { annotation: { type: "summary", description: "Signing out wipes the device only once no tab holds its data, and no tab reopens on it." } }, async ({ devices }) => {
  requires("devSignIn", "faults")
  test.setTimeout(240_000)
  const word = devices.word
  const [one] = await devices.openFaulty("Tab 1")
  const two = await devices.tab(one.device, "Tab 2")

  // A question ChatApi refused, kept on the device, shows in both tabs: both hold the device's data.
  await faults(one.page).questions.failNext("bad_request")
  const kept = `Never sent in two tabs ${word}`
  await one.ask(kept)
  await one.expectNotSent(kept)
  await two.expectNotSent(kept)
  const shapes = [firstShapes(one), firstShapes(two)]

  // Tab 2 is slow to unload: a "Leave site?" prompt holds it open, with its databases, until the test answers it.
  // The test adds the prompt, not the app, and a click gives the page the activation the browser requires for one.
  let leaving: Dialog | undefined
  two.page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") leaving = dialog
  })
  await two.page.evaluate(() => addEventListener("beforeunload", (event) => event.preventDefault()))
  await two.page.locator("body").click({ position: { x: 4, y: 4 } })

  // Tab 1 signs out. Tab 2 hears it and starts to unload, held by the prompt; tab 1's wipe waits for it, so tab 1
  // opens nothing of the session and the mark stays.
  await one.page.getByRole("button", { name: SIGN_OUT }).click()
  await expect.poll(() => leaving !== undefined, { message: "tab 2 started to unload", timeout: 30_000 }).toBe(true)
  try {
    await expect.poll(() => waitingForData(one.page), { message: "tab 1's wipe waits for tab 2", timeout: 30_000 }).toBe(true)
    expect(await wipeMark(one.page)).toBe("1")
    await expect(one.page.getByRole("main", { name: "App" })).toBeHidden()
  } finally {
    // Tab 2 leaves; the wipe finishes, and both tabs open as visitors on an empty device.
    await leaving!.accept()
  }
  for (const tab of [one, two]) {
    await expect(tab.page.getByText(SIGN_IN_TO_ASK), `${tab.name} opens as a visitor`).toBeVisible({ timeout: 60_000 })
    await expect(tab.question(kept), `${tab.name} shows nothing of the session`).toHaveCount(0)
  }
  await expect.poll(() => wipeMark(one.page), { message: "the wipe finished", timeout: 30_000 }).toBeNull()
  expect(await outboxSize(one.page), "the outbox holds nothing").toBe(0)
  for (const [index, tab] of [one, two].entries()) {
    const seen = shapes[index]!
    await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(seen[0]!.searchParams.get("offset"), `${tab.name} syncs from scratch`).toBe("-1")
    expect(seen[0]!.searchParams.get("handle")).toBeNull()
  }
  // No row of the session comes back: tab 1 opens again, and the unsent question stays gone from both.
  await one.reload()
  await expect(one.page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })
  await expect(one.question(kept)).toHaveCount(0)
  await expect(two.question(kept)).toHaveCount(0)
})

/** The shape requests `tab` makes from its next navigation on, in order: a navigation starts the list over. */
const firstShapes = (tab: Tab) => {
  const shapes: Array<URL> = []
  tab.page.on("framenavigated", (frame) => {
    if (frame === tab.page.mainFrame()) shapes.length = 0
  })
  tab.page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === SHAPE_ROUTE) shapes.push(url)
  })
  return shapes
}

/** Whether the page's boot is waiting to take the device's data from every other tab (the wipe's `smithers-data` lock). */
const waitingForData = (page: Page) =>
  page.evaluate(async () =>
    ((await navigator.locks.query()).pending ?? []).some((lock) => lock.name === "smithers-data" && lock.mode === "exclusive")
  )

/** The sign-out wipe's mark in the device's localStorage: `"1"` while a wipe is unfinished, else `null`. */
const wipeMark = (page: Page) => page.evaluate(() => localStorage.getItem("smithers-wipe"))

/** How many writes the device's outbox (IndexedDB `smithers-outbox`) holds; -1 when it can't be read. */
const outboxSize = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("smithers-outbox")
        open.onsuccess = () => {
          const database = open.result
          const stores = [...database.objectStoreNames]
          if (stores.length === 0) {
            database.close()
            return resolve(0)
          }
          const count = database.transaction(stores, "readonly").objectStore(stores[0]!).count()
          count.onsuccess = () => {
            database.close()
            resolve(count.result)
          }
          count.onerror = () => resolve(-1)
        }
        open.onerror = () => resolve(-1)
      }),
  )

test("another person signing in on this browser opens nothing of the device's; its owner finds it all when they return", { annotation: { type: "summary", description: "Another account can't see or send the device's draft or queued question; both are there when its owner signs in again." } }, async ({ devices }) => {
  requires("devPeople")
  test.setTimeout(180_000)
  const [alice] = await devices.open("Alice")
  const queued = `Queued by Alice ${devices.word}`
  const draft = `Alice's draft ${devices.word}`
  const origin = new URL(alice.page.url()).origin
  const secure = origin.startsWith("https:")
  // Local development's second person, Ben, is whoever the dev person cookie names (worker/DevChatApi.ts).
  const ben = { name: `${secure ? "__Host-" : ""}smithers_dev_person`, value: "teammate", url: origin, secure }

  await step("Alice queues a question offline, leaves a draft and closes the tab", async () => {
    await alice.offline()
    await alice.ask(queued)
    await alice.expectQueued(queued)
    await alice.composer.fill(draft)
    await expect(alice.composer).toHaveAttribute("data-draft", "saved", { timeout: 15_000 })
    await alice.page.close()
  })
  await step("Ben signs in on the same browser", async () => {
    await alice.device.context.addCookies([ben])
    await alice.device.online()
  })
  const benTab = await devices.tab(alice.device, "Ben")
  await step("Ben sees nothing of Alice's, and her question isn't sent as him", async () => {
    await expect(benTab.page.getByRole("button", { name: SIGN_OUT })).toBeVisible({ timeout: 30_000 })
    await benTab.openComposer()
    await expect(benTab.composer).toHaveValue("")
    await expect(benTab.question(queued)).toHaveCount(0)
    // Her write is still on the device, unopened, and Ben's tab posted nothing.
    expect(await outboxSize(benTab.page)).toBeGreaterThan(0)
    expect(benTab.asked).toEqual([])
    await benTab.page.close()
  })
  await step("Alice signs in again", () => alice.device.context.clearCookies({ name: ben.name }))
  const back = await devices.tab(alice.device, "Alice again")
  await step("Her draft is back, and her question is sent, as the one question it was", async () => {
    await back.openComposer()
    await expect(back.composer).toHaveValue(draft, { timeout: 30_000 })
    await expect(back.question(queued).getByText(QUEUED, { exact: true })).toHaveCount(0, { timeout: 60_000 })
    await expect(back.question(queued)).toHaveCount(1)
    // ChatApi took it from her tab (202); a send repeated until delivery is the same question (200).
    await expect.poll(() => back.asked.map((post) => post.status), { timeout: 60_000 }).toContain(202)
    expect(new Set(back.asked.map((post) => post.questionId)).size).toBe(1)
    const answered = back.asked.filter((post) => post.status !== undefined)
    expect(answered.every((post) => post.text === queued && (post.status === 202 || post.status === 200))).toBe(true)
  })
})

test("session expiry keeps Alice's draft for Alice; a different account sees it in neither tab, and she finds it again", { annotation: { type: "summary", description: "An expired session keeps the person's draft; another account never sees it in either tab; it is hers again when she returns." } }, async ({ devices }) => {
  requires("devSignIn", "devPeople")
  test.setTimeout(180_000)
  const [alice] = await devices.open("Alice")
  const draft = `Private draft ${devices.word}`
  await alice.openComposer()
  await alice.composer.fill(draft)
  await expect(alice.composer, "the private draft is durably saved before expiry").toHaveAttribute("data-draft", "saved")
  const origin = new URL(alice.page.url()).origin
  const secure = origin.startsWith("https:")
  const prefix = secure ? "__Host-" : ""
  // Change the real development session without invoking the app's sign-out/wipe action.
  await alice.device.context.addCookies([{ name: `${prefix}smithers_dev_signed_out`, value: "1", url: origin, secure }])
  await alice.reload()
  await expect(alice.page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })
  await alice.device.context.clearCookies({ name: `${prefix}smithers_dev_signed_out` })
  await alice.reload()
  await alice.openComposer()
  await expect(alice.composer).toHaveValue(draft)
  await alice.device.offline()
  await alice.reload()
  await alice.openComposer()
  await expect(alice.composer).toHaveValue(draft)
  await alice.device.online()
  await alice.device.context.addCookies([{ name: `${prefix}smithers_dev_person`, value: "teammate", url: origin, secure }])
  // Bob's tab follows Alice's live engine: its leader answers that another person is signed in now, and every tab
  // loads again on memory stores.
  const bob = await devices.tab(alice.device, "Bob")
  for (const tab of [alice, bob]) {
    await expect(tab.page.getByRole("button", { name: SIGN_OUT })).toBeVisible({ timeout: 60_000 })
    await tab.openComposer()
    await expect(tab.composer).toHaveValue("")
  }
  await alice.device.context.clearCookies({ name: `${prefix}smithers_dev_person` })
  await bob.page.close()
  await alice.reload()
  await alice.openComposer()
  await expect(alice.composer).toHaveValue(draft, { timeout: 30_000 })
})

test("a tab sealed while its owner was signed out opens their data once a session check says they are back", { annotation: { type: "summary", description: "Signed out, the owner's draft is sealed; when the next session check finds them signed in again, the tab reopens with it." } }, async ({ devices }) => {
  requires("devSignIn")
  test.setTimeout(180_000)
  const [alice] = await devices.open("Alice")
  const draft = `Sealed draft ${devices.word}`
  const origin = new URL(alice.page.url()).origin
  const secure = origin.startsWith("https:")
  const signedOutCookie = `${secure ? "__Host-" : ""}smithers_dev_signed_out`
  await step("Alice leaves a draft", async () => {
    await alice.openComposer()
    await alice.composer.fill(draft)
    await expect(alice.composer).toHaveAttribute("data-draft", "saved", { timeout: 15_000 })
  })
  await step("Her session ends: the tab opens sealed", async () => {
    await alice.device.context.addCookies([{ name: signedOutCookie, value: "1", url: origin, secure }])
    await alice.reload()
    await expect(alice.page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })
  })
  await step("She is signed in again, and the next session check finds her: the tab reopens with her draft", async () => {
    await alice.device.context.clearCookies({ name: signedOutCookie })
    // No reload: reconnecting is what makes the tab ask who is signed in (src/features/auth/auth.ts).
    await alice.device.offline()
    await alice.device.online()
    await expect.poll(() => alice.log.some((line) => line.includes("auth.device_identity") && line.includes("reopened")), { timeout: 60_000 }).toBe(true)
    await alice.ready()
    await expect(alice.page.getByRole("button", { name: SIGN_OUT })).toBeVisible({ timeout: 60_000 })
    await alice.openComposer()
    await expect(alice.composer).toHaveValue(draft, { timeout: 30_000 })
  })
})

test("an old tab's pending person write cannot use a different account's cookie", { annotation: { type: "summary", description: "A question queued offline remains bound to its author while the browser changes accounts." } }, async ({ devices }) => {
  requires("devPeople")
  // The other account's cookie refuses the old tab's write: Chrome logs that 401.
  expectServerError(401, QUESTIONS_ROUTE)
  test.setTimeout(180_000)
  const [alice] = await devices.open("Alice")
  await alice.device.offline()
  const pending = `Private pending ${devices.word}`
  await alice.ask(pending)
  await expect.poll(() => outboxSize(alice.page)).toBeGreaterThan(0)
  const origin = new URL(alice.page.url()).origin
  const secure = origin.startsWith("https:")
  await alice.device.context.addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_person`, value: "teammate", url: origin, secure }])
  const accepted: number[] = []
  alice.page.on("response", (response) => {
    if (new URL(response.url()).pathname === QUESTIONS_ROUTE && response.request().postDataJSON()?.text === pending) accepted.push(response.status())
  })
  await alice.device.online()
  const bob = await devices.tab(alice.device, "Bob")
  for (const tab of [alice, bob]) await expect(tab.question(pending)).toHaveCount(0, { timeout: 60_000 })
  expect(accepted.filter((status) => status === 200 || status === 202)).toEqual([])
  // Refused as Bob, the write isn't Not sent either: it waits on the device for Alice.
  expect(await outboxSize(bob.page)).toBeGreaterThan(0)
})

test("an expired session renders sign-in while its private outbox stays closed, and another account can't open it either", { annotation: { type: "summary", description: "Signed out, the device's drafts and queued questions stay closed and kept; another account can't open them." } }, async ({ devices }) => {
  requires("devSignIn", "devPeople")
  test.setTimeout(180_000)
  const [alice] = await devices.open("Alice")
  const pending = `Private outbox ${devices.word}`
  await alice.device.offline()
  await alice.ask(pending)
  await alice.composer.fill(`Private draft ${devices.word}`)
  await expect(alice.composer).toHaveAttribute("data-draft", "saved")
  await expect.poll(() => outboxSize(alice.page)).toBeGreaterThan(0)
  const origin = new URL(alice.page.url()).origin
  const secure = origin.startsWith("https:")
  const prefix = secure ? "__Host-" : ""
  await alice.device.context.addCookies([{ name: `${prefix}smithers_dev_signed_out`, value: "1", url: origin, secure }])
  // Close the writer before reconnecting: only the freshly opened page could restore the old IndexedDB outbox.
  await alice.page.close()
  await alice.device.online()
  const expired = await devices.tab(alice.device, "Expired")
  await expect(expired.page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 45_000 })
  await expect(expired.question(pending)).toHaveCount(0)
  expect(await outboxSize(expired.page), "expiry preserves the sealed old outbox instead of loading it").toBeGreaterThan(0)
  await alice.device.context.clearCookies({ name: `${prefix}smithers_dev_signed_out` })
  await alice.device.context.addCookies([{ name: `${prefix}smithers_dev_person`, value: "teammate", url: origin, secure }])
  await expired.reload()
  await expect(expired.page.getByRole("button", { name: SIGN_OUT })).toBeVisible({ timeout: 60_000 })
  await expect(expired.question(pending)).toHaveCount(0)
  expect(await outboxSize(expired.page), "another account leaves the old outbox closed and kept").toBeGreaterThan(0)
})

test("a signed-out follower cannot read the live owner's engine", { annotation: { type: "summary", description: "While the owner's engine remains live, a signed-out tab cannot list its runs or inspect their contents." } }, async ({ devices }) => {
  requires("devSignIn")
  test.setTimeout(180_000)
  const [alice] = await devices.open("Live owner")
  await alice.page.getByRole("link", { name: "Runs", exact: true }).click()
  const runs = alice.page.getByRole("table", { name: "Runs" })
  await expect(runs).toBeVisible({ timeout: 30_000 })
  await expect(runs).toContainText("watch/set", { timeout: 30_000 })
  const origin = new URL(alice.page.url()).origin
  const secure = origin.startsWith("https:")
  await alice.device.context.addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_signed_out`, value: "1", url: origin, secure }])
  // Keep Alice's page and leader alive throughout the follower's client-side navigation.
  const expired = await devices.tab(alice.device, "Signed out")
  await expect(expired.page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 45_000 })
  await expired.page.getByRole("link", { name: "Runs", exact: true }).click()
  await expect(expired.page.getByText("No runs yet")).toBeVisible({ timeout: 30_000 })
  await expect(expired.page.getByRole("table", { name: "Runs" })).toHaveCount(0)
  await expect(alice.page.getByRole("table", { name: "Runs" })).toContainText("watch/set")
})

test("an ownerless offline activation takes the verified person in place when the network returns", { annotation: { type: "summary", description: "After device storage is evicted offline, reconnecting verifies the account in place, with no reload, and asking succeeds." } }, async ({ devices }) => {
  requires("personalModel", "member", "ownConversation")
  test.setTimeout(180_000)
  const [tab] = await devices.open("Recovered device")
  await tab.page.addInitScript(() => {
    const record = (stage: string) => console.info("e2e.identity_network", { stage, online: navigator.onLine })
    record("load")
    addEventListener("online", () => record("window_online"))
    addEventListener("offline", () => record("window_offline"))
    document.addEventListener("online", () => record("document_online"), true)
  })
  // Keep the cached app shell and real session cookie while evicting OPFS, as a browser may under storage pressure.
  // Leave the app first so no worker or collection holds the old files open.
  await tab.page.goto("/api/auth/session")
  await tab.page.evaluate(async () => {
    await navigator.locks.request("smithers-data", { mode: "exclusive" }, () =>
      navigator.locks.request("smithers", { mode: "exclusive" }, async () => {
        const directory = await navigator.storage.getDirectory()
        await directory.removeEntry("smithers", { recursive: true })
      }))
  })
  await tab.device.offline()
  await tab.page.goto(appHome())
  // Chromium keeps context-level HTTP emulation across this cached navigation but initializes the new renderer's
  // navigator.onLine to true. Correct only its connection state; context.setOffline owns the HTTP fault.
  const network = await tab.device.context.newCDPSession(tab.page)
  await network.send("Network.overrideNetworkState", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  // Offline, the evicted device opens as a visitor's: the app's home, or a deployment run's own branch with its public
  // chrome and no workspace, which only ChatApi can open (src/features/branch/actions.ts, `offline`).
  await tab.ready()
  expect(await tab.page.evaluate(() => navigator.onLine), "the evicted device activates offline").toBe(false)
  await tab.page.evaluate(() => Object.assign(window, { e2eSamePage: true }))
  await tab.device.online()
  await network.send("Network.overrideNetworkState", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  expect(await tab.page.evaluate(() => navigator.onLine), "the browser reports connectivity restored").toBe(true)
  await expect.poll(() => tab.log.some((line) => line.includes("e2e.identity_network") && line.includes("window_online")), { message: "the browser delivered its real online event" }).toBe(true)
  // The leader adopts the visitor's data without reloading this page. A branch opened offline still reopens
  // its workspace when connectivity returns; wait for that route's conversation before asking.
  await expect.poll(() => tab.log.some((line) => line.includes("auth.device_identity") && line.includes("adopted")), { timeout: 60_000 }).toBe(true)
  expect(await tab.page.evaluate(() => (window as { e2eSamePage?: boolean }).e2eSamePage), "the page never reloaded").toBe(true)
  await expect(tab.conversation, "the verified page shows its conversation").toBeVisible({ timeout: 30_000 })
  const text = `Recovered authority ${devices.word}`
  const accepted = tab.page.waitForResponse((response) => new URL(response.url()).pathname === QUESTIONS_ROUTE && response.request().postDataJSON()?.text === text)
  await tab.ask(text)
  expect((await accepted).status()).toBe(202)
})

test("an evicted device's earlier owner keeps their queued question: the next person adopts the device in place and never sends it", { annotation: { type: "summary", description: "The browser evicts the device store but keeps the outbox; the next person to sign in takes the device in place, and the earlier owner's queued question is never sent as them." } }, async ({ devices }) => {
  requires("devSignIn", "devPeople")
  test.setTimeout(180_000)
  const [tab] = await devices.open("Shared laptop")
  const origin = new URL(tab.page.url()).origin
  const pending = `Earlier owner's question ${devices.word}`
  await test.step("The owner asks offline: the question waits in the outbox", async () => {
    await tab.device.offline()
    await tab.ask(pending)
    await expect.poll(() => outboxSize(tab.page), { timeout: 30_000 }).toBeGreaterThan(0)
  })
  await test.step("The browser evicts the device store and keeps the outbox; a teammate signs in", async () => {
    // Leave the app while still offline, so nothing sends the question, then evict OPFS from a page of the origin
    // that runs no app: no worker or collection holds the files open.
    await tab.page.goto("about:blank")
    await tab.device.context.setOffline(false)
    await tab.page.goto("/api/auth/session")
    await tab.page.evaluate(async () => {
      await navigator.locks.request("smithers-data", { mode: "exclusive" }, () =>
        navigator.locks.request("smithers", { mode: "exclusive" }, async () => {
          const directory = await navigator.storage.getDirectory()
          await directory.removeEntry("smithers", { recursive: true })
        }))
    })
    expect(await outboxSize(tab.page), "the outbox kept the earlier owner's question").toBeGreaterThan(0)
    const secure = origin.startsWith("https:")
    await tab.device.context.addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_person`, value: "teammate", url: origin, secure }])
  })
  const sent: Array<number> = []
  tab.page.on("request", (request) => {
    if (new URL(request.url()).pathname === QUESTIONS_ROUTE && request.postDataJSON()?.text === pending) sent.push(Date.now())
  })
  await test.step("The device opens offline as a visitor's; online, the teammate takes it in place", async () => {
    await tab.device.offline()
    await tab.page.goto(appHome())
    const network = await tab.device.context.newCDPSession(tab.page)
    await network.send("Network.overrideNetworkState", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await tab.ready()
    await tab.page.evaluate(() => Object.assign(window, { e2eSamePage: true }))
    await tab.device.online()
    await network.send("Network.overrideNetworkState", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await expect.poll(() => tab.log.some((line) => line.includes("auth.device_identity") && line.includes("adopted")), { timeout: 60_000 }).toBe(true)
    await expect(tab.page.getByRole("button", { name: SIGN_OUT })).toBeVisible({ timeout: 30_000 })
    expect(await tab.page.evaluate(() => (window as { e2eSamePage?: boolean }).e2eSamePage), "the page never reloaded").toBe(true)
  })
  await test.step("The earlier owner's question is never shown or sent as the teammate, and stays sealed in the outbox", async () => {
    await expect(tab.conversation).toBeVisible({ timeout: 30_000 })
    const text = `Teammate's question ${devices.word}`
    const accepted = tab.page.waitForResponse((response) => new URL(response.url()).pathname === QUESTIONS_ROUTE && response.request().postDataJSON()?.text === text)
    await tab.ask(text)
    expect((await accepted).status()).toBe(202)
    await expect(tab.question(pending)).toHaveCount(0)
    expect(sent, "the earlier owner's question never left as the teammate").toEqual([])
    expect(await outboxSize(tab.page), "it stays in the outbox, sealed for its owner").toBeGreaterThan(0)
  })
})


pageTest.describe("github", () => {
  requires("githubSignIn")
  // A browser of its own, signed out: the run's stored session stays out of it, and nothing here follows GitHub.
  pageTest.use({ ...signedOut })

  pageTest("github: Sign in with GitHub sends a signed-out visitor to GitHub to authorize, and the run's session is the test account", {
    annotation: {
      type: "summary",
      description: "A visitor's Sign in with GitHub goes to GitHub's authorize page for this deployment; the test account's session is signed in with its role.",
    },
  }, async ({ page, playwright }) => {
    const origin = new URL(baseURL).origin
    await step("Open Smithers signed out: Sign in with GitHub", async () => {
      await page.goto("/app")
      await expect(page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole("link", { name: SIGN_IN }).first()).toBeVisible()
    })
    await step("Sign in with GitHub goes to GitHub's authorize page, coming back to this deployment", async () => {
      // The request alone, never followed: GitHub's page is the account's to answer, and the setup already did.
      const response = await page.request.get("/api/auth/sign-in?return=/app", { maxRedirects: 0 })
      expect(response.status()).toBe(302)
      const authorize = new URL(response.headers().location!)
      expect(`${authorize.origin}${authorize.pathname}`).toBe("https://github.com/login/oauth/authorize")
      expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}${CALLBACK_ROUTE}`)
      expect(authorize.searchParams.get("state")).toMatch(/.+/)
      expect(authorize.searchParams.get("code_challenge")).toMatch(/.+/)
    })
    await step("The run's session is the test account, with its role", async () => {
      const signedIn = await playwright.request.newContext({ baseURL: origin, storageState: sessionFiles(baseURL).session })
      try {
        const response = await signedIn.get("/api/auth/session")
        expect(response.status()).toBe(200)
        expect(await response.json()).toMatchObject({ signedIn: true, login: me().login, personId: me().personId, role: me().role })
      } finally {
        await signedIn.dispose()
      }
      // This browser is still a visitor: the session never reached it.
      expect(await (await page.request.get("/api/auth/session")).json()).toMatchObject({ signedIn: false })
    })
  })
})

test("a failed first session check: the composer comes back by itself once ChatApi answers", { annotation: { type: "summary", description: "A new device whose first session check fails shows the sign-in prompt, then the composer once ChatApi answers, with no click and no reload." } }, async ({ devices }) => {
  requires("devSignIn", "faults")
  test.setTimeout(180_000)
  // A new device, signed in, opens while ChatApi answers every session read 503, the engine worker's included.
  const tab = await devices.openNew("New device", faultyApp("session-503"))
  const page = tab.page
  await test.step("ChatApi can't say who is signed in: the sign-in prompt shows", async () => {
    await expect(page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })
    await expect(tab.chatButton).toBeHidden()
  })
  await test.step("ChatApi answers again", async () => {
    // A mark on this page: a reload would lose it.
    await page.evaluate(() => Object.assign(window, { e2eSamePage: true }))
    await faults(page).session.heal()
  })
  await test.step("The composer comes back by itself, on the same page", async () => {
    await expect(tab.chatButton).toBeVisible({ timeout: 35_000 })
    await expect(page.getByText(SIGN_IN_TO_ASK)).toBeHidden()
    expect(await page.evaluate(() => (window as { e2eSamePage?: boolean }).e2eSamePage), "the page never reloaded").toBe(true)
    expect(tab.log.some((line) => line.includes("auth.device_identity") && line.includes("adopted")), "the visitor's data is the person's now").toBe(true)
  })
  await test.step("Asking works", async () => {
    await tab.askAndWaitTaken(`After the outage ${devices.word}`)
    expect(await page.evaluate(() => (window as { e2eSamePage?: boolean }).e2eSamePage), "still the same page").toBe(true)
  })
})
