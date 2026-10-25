import { answerTo, questionIn } from "./messages"
import { test as base, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { DEV_URL } from "../dev/https"
import { recordConsole } from "./console"
import { describeCrashes, watchCrashes } from "./crashes"
import { devReload } from "./devReload"
import { faultyApp, faults } from "./faults"
import { allServerRows, type Row } from "./shape"
import { appHome, atOwnPlace, guard, requires, target, UndeclaredNeed } from "./target"
import {
  COULDNT_ANSWER,
  expect,
  guardSpend,
  redactedRequests,
  NOT_SENT,
  OFFLINE,
  PAGE_SIZE,
  QUEUED,
  recordActions,
  spinnersSeen,
  step,
  SYNC_FAILED,
  themeOf,
  watchForSpinners,
  writeManifest,
} from "./fixtures"

// Multi-device helpers for the local-first tests. A device is its own browser context: its own memory, network and
// video. A tab is one page in a device. Every tab holds the conversation Electric syncs from Postgres, and asks
// through ChatApi (`POST /api/questions`). No mocks: `setOffline` is the device losing its network, and a device
// opened on the app's faulty services (`openFaulty`, e2e/faults.ts) throws a switch for the sync service being down.

export { allServerRows, COULDNT_ANSWER, expect, NOT_SENT, OFFLINE, PAGE_SIZE, QUEUED, type Row, SYNC_FAILED }

// A laptop's window, as on the default page (playwright.config.ts): each device's video is the whole app at 1:1, and
// e2e/gifs.mjs lays several side by side without scaling them down (Will, 2026-10-20: "video is too zoomed in").
const VIEWPORT = { width: 1280, height: 800 }

export type Message = { role: string; text: string; state: "pending" | "streaming" | "settled" }

// A small device label in each video, so a GIF shows which device is which and which is offline.
// It sits outside the app's root, ignores the pointer and is hidden from assistive technology.
const label = (name: string) => {
  const paint = () => {
    if (!document.body) return
    let badge = document.getElementById("e2e-device")
    if (!badge) {
      badge = document.createElement("div")
      badge.id = "e2e-device"
      badge.setAttribute("aria-hidden", "true")
      Object.assign(badge.style, {
        position: "fixed",
        top: "6px",
        right: "6px",
        zIndex: "2147483647",
        pointerEvents: "none",
        font: "600 12px/1.6 system-ui, sans-serif",
        color: "#fff",
        padding: "0 8px",
        borderRadius: "999px",
      })
      document.body.append(badge)
    }
    const state = sessionStorage.getItem("e2e-network") ?? ""
    badge.textContent = state === "" ? name : `${name} · ${state}`
    badge.style.background = state === "" ? "#1f2937" : "#b42318"
  }
  addEventListener("DOMContentLoaded", paint)
  addEventListener("e2e-network", paint)
  // Video only: follow the newest message the way a reader scrolls down, so each GIF shows its flow's messages.
  // The app opens scrolled to the oldest loaded message; chat.spec.ts "in view" tests that without this.
  let queued = false
  const follow = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const root = document.scrollingElement
      if (root) root.scrollTop = root.scrollHeight
    })
  }
  addEventListener("DOMContentLoaded", () => new MutationObserver(follow).observe(document.body, { childList: true, subtree: true, characterData: true }))
}

// Every message on screen, in order, as a person reads it. `pending` is "Smithers is answering" with no text yet.
const readMessages = (word: string | null) => {
  const region = document.querySelector('section[aria-label="Conversation"]')
  const articles = [...(region?.querySelectorAll(".sui-chat-message") ?? [])]
  const read = (article: Element) => {
    const bubble = article.querySelector<HTMLElement>(".sui-chat-bubble")
    const response = article.querySelector('[data-slot="message-response"]')
    const state = bubble?.getAttribute("role") === "status" ? "pending" : response?.getAttribute("data-streaming") === "true" ? "streaming" : "settled"
    return { role: article.getAttribute("data-role") ?? "", text: (bubble?.innerText ?? "").trim(), state }
  }
  if (word === null) return articles.map(read)
  // This test's part of the shared conversation: each question with `word`, and the message right after it.
  return articles.flatMap((article, index) =>
    article.getAttribute("data-role") === "user" && article.textContent?.includes(word)
      ? [article, articles[index + 1]].filter((element): element is Element => element !== undefined).map(read)
      : [],
  )
}

/** One `POST /api/questions` a tab made, and ChatApi's status, or the network error when it never answered. */
export type Asked = { questionId: string; answerId: string; text: string; status?: number; error?: string }

export class Device {
  readonly tabs: Array<Tab> = []
  constructor(
    readonly name: string,
    readonly context: BrowserContext,
    // Its tabs run the app on its faulty services (`/app?faults`), healthy until the test throws a switch.
    readonly faulty: boolean,
  ) {}

  // The device loses its network: no sync and no asking.
  offline() {
    return step(`${this.name} goes offline`, async () => {
      await this.context.setOffline(true)
      await this.paint("offline")
    })
  }

  online() {
    return step(`${this.name} comes back online`, async () => {
      await this.context.setOffline(false)
      await this.paint("")
    })
  }

  // The sync service is down for this device: every shape request its tabs make from now on fails on the network,
  // as if Electric (or its proxy) were unreachable. Asking still reaches ChatApi. Only a faulty device has the switch.
  syncDown() {
    return step(`${this.name}: sync goes down`, async () => {
      for (const tab of this.faultyTabs()) await faults(tab.page).shapes.down()
      await this.paint("sync down")
    })
  }

  syncUp() {
    return step(`${this.name}: sync comes back`, async () => {
      for (const tab of this.faultyTabs()) await faults(tab.page).shapes.heal()
      await this.paint("")
    })
  }

  private faultyTabs() {
    if (!this.faulty) throw new Error(`${this.name} runs the real services; open it with devices.openFaulty to throw a fault`)
    return this.tabs.filter((tab) => !tab.page.isClosed())
  }

  private async paint(state: string) {
    for (const tab of this.tabs) {
      if (tab.page.isClosed()) continue
      await tab.page
        .evaluate((state) => {
          sessionStorage.setItem("e2e-network", state)
          dispatchEvent(new Event("e2e-network"))
        }, state)
        .catch(() => undefined)
    }
  }
}

const isQuestions = (url: string) => new URL(url).pathname === "/api/questions"

export class Tab {
  readonly conversation: Locator
  readonly composer: Locator
  readonly composerForm: Locator
  readonly chatButton: Locator
  // The connection pill, in the header's live region: empty while the connection is up.
  readonly pill: Locator
  readonly loadEarlier: Locator
  readonly log: Array<string> = []
  readonly crashes: ReturnType<typeof watchCrashes>
  // Every question this tab posted to ChatApi, in order.
  readonly asked: Array<Asked> = []
  // Each time the dev server reloaded this tab, once it had opened, because a file it serves changed: when, and which.
  readonly devReloads: Array<string> = []
  // Set once `Devices.tab` has opened it: a reload before then only restarts a page no step has used yet.
  opened = false
  // Seconds from the test's first device to this tab opening: where its video starts in the GIF.
  readonly openedAt: number

  constructor(
    readonly name: string,
    readonly device: Device,
    readonly page: Page,
    readonly startedAt: number,
  ) {
    this.conversation = page.getByRole("region", { name: "Conversation", exact: true })
    this.composer = page.getByRole("textbox", { name: "Message Smithers" })
    this.composerForm = page.locator('form[data-slot="chat-composer"]')
    this.chatButton = page.getByRole("button", { name: /Chat/ })
    this.pill = page.locator('[aria-label="Connection"]')
    this.loadEarlier = page.getByRole("button", { name: "Load earlier" })
    this.openedAt = (Date.now() - startedAt) / 1000
    this.crashes = watchCrashes(page, name, this.log)
    const at = () => `${((Date.now() - startedAt) / 1000).toFixed(2)}s`
    recordConsole(page, this.log, () => `${at()} `)
    page.on("pageerror", (error) => this.log.push(`${at()} pageerror: ${error.message}`))
    // Vite reloads every page it serves when a module changes (its HMR socket's `full-reload`), as when someone edits
    // the checkout a shared dev server serves. The page restarts mid-test, losing its memory and its fault switches,
    // so `teardown` voids a test that ran through one once the tab had opened. An HTML file's reload reaches only the
    // page it is.
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        const reload = devReload(payload)
        if (reload === undefined) return
        if (this.opened) this.devReloads.push(`${at()} ${reload}`)
        this.log.push(`${at()} dev server: full-reload ${reload}`)
      }),
    )
    page.on("request", (request) => {
      if (!isQuestions(request.url()) || request.method() !== "POST") return
      const body = request.postDataJSON() as { id: string; answerId: string; text: string }
      this.asked.push({ questionId: body.id, answerId: body.answerId, text: body.text })
      this.log.push(`${at()} request: POST /api/questions ${body.id} answer ${body.answerId}`)
    })
    page.on("response", (response) => {
      if (!isQuestions(response.url())) return
      const body = response.request().postDataJSON() as { id: string }
      // A question sent again is posted again: each response or failure goes to the first post of its id still open.
      const asked = this.asked.find((post) => post.questionId === body.id && post.status === undefined && post.error === undefined)
      if (asked) asked.status = response.status()
      this.log.push(`${at()} response: ${response.status()} POST /api/questions ${body.id}`)
    })
    page.on("requestfailed", (request) => {
      const error = request.failure()?.errorText
      if (isQuestions(request.url())) {
        const body = request.postDataJSON() as { id: string }
        const asked = this.asked.find((post) => post.questionId === body.id && post.status === undefined && post.error === undefined)
        if (asked) asked.error = error
      }
      this.log.push(`${at()} requestfailed: ${request.method()} ${new URL(request.url()).pathname} ${error}`)
    })
  }

  // The app has opened the conversation: the shell renders only once its first snapshot loaded.
  // The app's home, or a deployment run's own branch (e2e/target.ts `home`), whose chrome names the branch. The branch's
  // pending chrome names it too while its route still loads (src/screens/branch/BranchPendingScreen.tsx), so the page is
  // open once the router's loading bar is gone as well.
  async ready() {
    const opened = atOwnPlace(this.page.url()) ? this.page.getByRole("navigation", { name: "Branch" }) : this.page.getByRole("main", { name: "App" })
    await expect(opened, `${this.name}: the app opens`).toBeVisible({ timeout: 30_000 })
    await expect(this.page.getByRole("progressbar", { name: "Loading page" }), `${this.name}: the page finished loading`)
      .toHaveCount(0, { timeout: 60_000 })
  }

  // A reload another navigation overtakes, such as the service worker's update reloading the page, still ends with
  // the app open, which `ready` checks.
  // Closes the tab without its unload handlers, as a killed tab or a crashed browser does. Its device keeps what it
  // stored: the conversation, the outbox and the engine's journal.
  close() {
    return step(`Close ${this.name}`, () => this.page.close({ runBeforeUnload: false }))
  }

  reload() {
    return step(`Reload ${this.name}`, async () => {
      await this.page.reload().catch((error: Error) => {
        if (!error.message.includes("ERR_ABORTED")) throw error
      })
      await this.ready()
    })
  }

  async offline() {
    await this.device.offline()
  }

  async online() {
    await this.device.online()
  }

  question(text: string) {
    return questionIn(this.conversation, text)
  }

  // The first assistant bubble after the question: its answer.
  answerTo(text: string) {
    return answerTo(this.conversation, text)
  }

  // The pill says the device is offline, with `queued` questions waiting: `Offline` or `Offline · 2`.
  async expectOffline(queued = 0, timeout = 30_000) {
    const copy = queued === 0 ? OFFLINE : `${OFFLINE} · ${queued}`
    await expect(this.pill, `${this.name}: the pill says ${copy}`).toContainText(copy, { timeout })
  }

  // The pill is gone: the shape is up to date and nothing is queued.
  async expectUp(timeout = 30_000) {
    await expect(this.pill, `${this.name}: the pill hides`).toBeEmpty({ timeout })
  }

  // The question shows queued: badged Queued, since the pill shows.
  async expectQueued(text: string) {
    await expect(this.question(text), `${this.name}: "${text}" shows queued`).toHaveAttribute("data-state", "queued")
    await expect(this.question(text).getByText(QUEUED, { exact: true })).toBeVisible()
  }

  // The question stays on this device, Not sent.
  async expectNotSent(text: string, timeout = 30_000) {
    await expect(this.question(text), `${this.name}: "${text}" is not sent`).toHaveAttribute("data-state", "unsent", { timeout })
    await expect(this.question(text).getByText(NOT_SENT, { exact: true })).toBeVisible()
  }

  // The answer ended as failed: the failure copy only, with Retry; no "Smithers is answering" and no streaming caret.
  async expectFailed(text: string, timeout = 30_000) {
    const answer = this.answerTo(text)
    await expect(answer.locator(".sui-chat-bubble"), `${this.name}: the answer to "${text}" ends as failed`).toHaveText(COULDNT_ANSWER, { timeout })
    await expect(answer).toHaveAttribute("data-role", "assistant")
    await expect(answer.getByRole("status")).toHaveCount(0)
    await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
  }

  // The answer finished and contains `word`; model wording varies, so never an exact match.
  async expectAnswered(text: string, word: string, timeout = 60_000) {
    const answer = this.answerTo(text)
    await expect(answer, `${this.name}: the answer to "${text}" contains ${word}`).toContainText(word, { timeout })
    await expect(answer).toHaveAttribute("data-role", "assistant")
    await expect(answer.locator('[data-slot="message-response"]'), `${this.name}: the answer to "${text}" finished`).toHaveAttribute(
      "data-streaming",
      "false",
      { timeout },
    )
  }

  openComposer() {
    return step(`${this.name}: open the composer`, async () => {
      if (await this.composer.isHidden()) await this.page.keyboard.press("ControlOrMeta+k")
      await expect(this.composer).toBeVisible()
    })
  }

  // Types a question and presses Enter once the composer is ready to send. A deployment run asks only in its own
  // conversation (e2e/target.ts `ownConversation`): without one the test stops here, blocked, before asking.
  send(text: string) {
    // A slash command runs on the device and asks nothing; anything else is a question.
    if (!text.startsWith("/")) {
      requires("personalModel", "ownConversation")
      // In a deployment the tab must be in the run's own conversation, or the question would reach the team's home.
      if (target === "deployment" && !atOwnPlace(this.page.url())) throw new UndeclaredNeed("ownConversation")
    }
    return step(`${this.name}: send "${text}"`, async () => {
      await this.openComposer()
      await expect(this.composerForm, `${this.name}: the composer is ready to send`).toHaveAttribute("data-status", "ready", { timeout: 30_000 })
      await this.composer.fill(text)
      await this.composer.press("Enter")
    })
  }

  // Asks a question and checks it shows on this tab at once, whatever the network: it shows from the device.
  ask(text: string) {
    return step(`${this.name}: ask "${text}"`, async () => {
      await this.send(text)
      await expect(this.question(text), `${this.name}: "${text}" shows at once`).toHaveCount(1, { timeout: 1_000 })
      await expect(this.composer).toHaveValue("")
    })
  }

  // The id of the question with `text`, from the conversation.
  async idOf(text: string) {
    return (await this.question(text).first().getAttribute("data-id"))!
  }

  // Asks a question and waits until ChatApi took it (202): from then on the server answers it, whatever this tab does.
  async askAndWaitTaken(text: string) {
    const taken = this.page.waitForResponse((response) => isQuestions(response.url()) && response.request().postDataJSON()?.text === text)
    await this.ask(text)
    const response = await taken
    expect(response.status(), `${this.name}: ChatApi took "${text}"`).toBe(202)
    return response
  }

  // This test's questions and the message after each, in the order this tab shows them.
  thread(word: string): Promise<Array<Message>> {
    return this.page.evaluate(readMessages, word) as Promise<Array<Message>>
  }

  // The whole conversation on this tab.
  transcript(): Promise<Array<Message>> {
    return this.page.evaluate(readMessages, null) as Promise<Array<Message>>
  }
}

// Waits until every tab shows the same settled thread of `length` messages, and returns it.
export const expectSameThread = async (tabs: Array<Tab>, word: string, length: number, timeout = 60_000) => {
  let thread: Array<Message> = []
  await expect(async () => {
    const threads = await Promise.all(tabs.map((tab) => tab.thread(word)))
    for (const [index, other] of threads.entries()) {
      expect(other, `${tabs[index]!.name} shows the same messages, in the same order, as ${tabs[0]!.name}`).toEqual(threads[0])
    }
    expect(threads[0], "every question and answer, once each").toHaveLength(length)
    expect(threads[0]!.filter((message) => message.state !== "settled"), "no answer still streaming").toEqual([])
    thread = threads[0]!
  }).toPass({ timeout, intervals: [100, 250, 500, 1_000] })
  return thread
}

// [question, answer] pairs of a settled thread; every question is followed by exactly one assistant message.
export const pairs = (thread: Array<Message>) => {
  const result: Array<[question: Message, answer: Message]> = []
  for (let index = 0; index < thread.length; index += 2) {
    expect(thread[index]?.role, `message ${index} is a question`).toBe("user")
    expect(thread[index + 1]?.role, `message ${index + 1} is the answer to "${thread[index]?.text}"`).toBe("assistant")
    result.push([thread[index]!, thread[index + 1]!])
  }
  return result
}

// Postgres' rows for this test's questions: each question with `word`, and its answer.
export const serverRows = async (request: APIRequestContext, word: string): Promise<Array<Row>> => {
  const ordered = await allServerRows(request)
  const mine = new Set(ordered.filter((row) => row.role === "user" && row.text.includes(word)).map((row) => row.id))
  return ordered.filter((row) => mine.has(row.id) || (row.question_id !== null && mine.has(row.question_id)))
}

class Devices {
  private extraHTTPHeaders: Record<string, string> = {}

  /** Content-free capture headers, applied before any device starts its worker. */
  withRequestHeaders(headers: Record<string, string>) { this.extraHTTPHeaders = { ...headers } }

  // A word unique to this test run: the conversation is shared and keeps every earlier run's messages.
  readonly word = `lf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  private readonly startedAt = Date.now()
  private readonly all: Array<Device> = []
  private viewport = VIEWPORT

  /** Record responsive proofs at their actual viewport size, without letterboxing or cropping. */
  atWidth(width: number) {
    this.viewport = { width, height: VIEWPORT.height }
    return this
  }


  constructor(
    private readonly browser: Browser,
    private readonly testInfo: TestInfo,
  ) {}

  // Opens one device per name, in parallel, each on /app with its conversation open, on the real services.
  open(...names: Array<string>) {
    return this.openOn(false, names)
  }

  // As `open`, on the app's faulty services: healthy until the test throws a switch, such as `Device.syncDown`.
  openFaulty(...names: Array<string>) {
    return this.openOn(true, names)
  }

  // As `open`, signed in as local development's second person, a Member (`smithers_dev_person=teammate`,
  // worker/DevChatApi.ts), so a test has two people on one laptop. Against a deployment it needs real sign-in instead.
  openTeammate(...names: Array<string>) {
    return this.openOn(false, names, { name: "smithers_dev_person", value: "teammate" })
  }

  // As `open`, signed in as local development's person `person` (`teammate`, a Member, `guest`, a Guest, or
  // `maintainer`, a Maintainer: worker/DevChatApi.ts), so a test has up to four people on one laptop.
  openAs(person: "teammate" | "guest" | "maintainer", ...names: Array<string>) {
    return this.openOn(false, names, { name: "smithers_dev_person", value: person })
  }

  // Opens one new device straight at `path`, as a person's first visit: no service worker in control yet and no second
  // load, so the page's first activation is the one the test watches. On the app's faulty services when `path` opens
  // them (`faultyApp`, e2e/faults.ts).
  openNew(name: string, path: string) {
    return step(`Open ${name}, a new device`, async () => {
      const [tab] = await this.openEach(path.includes("faults"), [name], undefined, path)
      return tab!
    })
  }

  private openOn(faulty: boolean, names: Array<string>, cookie?: { readonly name: string; readonly value: string }) {
    // A dev build's faulty services and local development's people: `requires("faults")`, `requires("devPeople")`.
    if (faulty) guard("faults")
    if (cookie !== undefined) guard("devPeople")
    const how = faulty ? " on faulty services" : cookie !== undefined ? ` as the ${cookie.value}` : ""
    return step(`Open ${names.join(", ")}${how}`, () => this.openEach(faulty, names, cookie))
  }

  private async openEach(
    faulty: boolean,
    names: Array<string>,
    cookie?: { readonly name: string; readonly value: string },
    path?: string,
  ) {
    return Promise.all(
      names.map(async (name) => {
        const context = await this.browser.newContext({
          viewport: this.viewport,
          extraHTTPHeaders: this.extraHTTPHeaders,
          // The test's mode, from the first frame (e2e/fixtures.ts `themeOf`).
          colorScheme: themeOf(this.testInfo),
          recordVideo: { dir: this.testInfo.outputPath("videos"), size: this.viewport },
        })
        if (cookie !== undefined) {
          // Over HTTPS, as the dev server and production serve the app, ChatApi reads the `__Host-` name, which a
          // browser keeps only when it is Secure (worker/SignIn.ts `cookieNames`).
          const url = this.testInfo.project.use.baseURL ?? DEV_URL
          const secure = url.startsWith("https:")
          await context.addCookies([{ name: `${secure ? "__Host-" : ""}${cookie.name}`, value: cookie.value, url, secure }])
        }
        const device = new Device(name, context, faulty)
        this.all.push(device)
        return path === undefined ? this.tab(device, name) : this.openTab(device, name, path)
      }),
    )
  }

  // Opens another tab of the same device: same browser context, its own page and memory. A device's first page waits
  // until the service worker is active, then loads again online, under its control: that is the one earlier visit an
  // offline reload needs. In production the service worker precaches the whole shell as it installs; under the dev server it keeps
  // each module a controlled page fetched, and the first page's modules came before it took control.
  tab(device: Device, name: string) {
    return step(`Open tab ${name}`, () => this.openTab(device, name))
  }

  private async openTab(device: Device, name: string, path?: string) {
    const first = device.tabs.length === 0 && path === undefined
    const page = await device.context.newPage()
    await page.addInitScript(label, name)
    await page.addInitScript(watchForSpinners)
    await recordActions(page, this.testInfo, name)
    const tab = new Tab(name, device, page, this.startedAt)
    device.tabs.push(tab)
    await page.goto(path ?? (device.faulty ? faultyApp() : appHome()))
    await tab.ready()
    if (first) {
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
      await tab.reload()
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 })
    }
    tab.opened = true
    return tab
  }

  async teardown() {
    const tabs = this.all.flatMap((device) => device.tabs)
    await Promise.all(tabs.map((tab) => tab.crashes.stop()))
    const crashes = tabs.flatMap((tab) => tab.crashes.failure === undefined ? [] : [tab.crashes.failure])
    describeCrashes(this.testInfo, crashes)
    expect.soft(crashes, crashes.join("\n") || "no page crashed").toEqual([])
    for (const tab of tabs) {
      if (tab.page.isClosed() || tab.crashes.failure !== undefined) continue
      expect.soft(await spinnersSeen(tab.page), `${tab.name} never showed a loading state`).toEqual([])
    }
    for (const tab of tabs) {
      expect
        .soft(tab.devReloads, `${tab.name}: the dev server never reloaded it mid-test (a watched file changed); a run through one is void`)
        .toEqual([])
    }
    const failed = this.testInfo.status !== this.testInfo.expectedStatus
    if (failed) {
      // Saved beside the test's videos and attached: each tab's browser and network log, screenshot, and what it showed.
      const save = async (name: string, body: string | Buffer, contentType: string) => {
        const path = this.testInfo.outputPath(name)
        await writeFile(path, body)
        await this.testInfo.attach(name, { path, contentType })
      }
      for (const tab of tabs) {
        const slug = tab.name.replace(/\W+/g, "-")
        await save(`${slug}-browser.log`, tab.log.join("\n"), "text/plain")
        if (tab.page.isClosed() || tab.crashes.failure !== undefined) continue
        const shot = await tab.page.screenshot({ timeout: 5_000 }).catch(() => undefined)
        if (shot) await save(`${slug}.png`, shot, "image/png")
        const thread = await tab.thread(this.word).catch((error: unknown) => ({ error: String(error) }))
        await save(`${slug}-thread.json`, JSON.stringify({ thread, asked: tab.asked }, null, 2), "application/json")
      }
    }
    await Promise.all(this.all.map((device) => device.context.close().catch(() => undefined)))
    // What e2e/gifs.mjs needs to lay the videos side by side, each starting when its tab opened.
    const videos = await Promise.all(
      tabs.map(async (tab) => ({ name: tab.name, video: await tab.page.video()?.path(), openedAt: tab.openedAt })),
    )
    await writeManifest(this.testInfo, "devices.json", this.startedAt, videos, { word: this.word })
  }
}

// Built on Playwright's own test, not fixtures.ts': a device test opens its own contexts and saves each tab's log,
// so it needs no default page.
export const test = base.extend<{ devices: Devices; spendGuard: void }, { redactedRequests: void }>({
  redactedRequests: [...redactedRequests],
  // A deployment run stops asking once its answers spent the run's token budget (e2e/spend.ts).
  spendGuard: [async ({ playwright }, use) => use(await guardSpend(() => playwright.request.newContext())), { auto: true }],
  devices: async ({ browser }, use, testInfo) => {
    const devices = new Devices(browser, testInfo)
    await use(devices)
    await devices.teardown()
  },
})
