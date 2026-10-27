import { persistent } from "./persistent"
import { type APIRequestContext, test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test"
import { readdir, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { recordConsole } from "./console"
import { describeCrashes, watchCrashes } from "./crashes"
import { themeFor } from "./frames.ts"
import { redactRequestErrors } from "./redact"
import { allServerRows } from "./shape"
import { runStartedAt, spendGuard, tokenBudget } from "./spend"
import { meets, target } from "./target"
import { problems, UNDECLARED, type Watched } from "./watch"

// The status copy (docs/decisions/0002-local-first.md §2) and how many messages show before Load earlier: chat's
// contract, which the app and these tests share.
export { COULDNT_ANSWER, NOT_SENT, OFFLINE, PAGE_SIZE, QUEUED, SYNC_FAILED } from "../src/features/chat/contract"

/** Matching text on the visible surface, excluding code viewers’ retained plain-text fallbacks. */
export const visibleText = (scope: Page | Locator, text: string | RegExp): Locator =>
  scope.getByText(text, { exact: false }).filter({ visible: true })

/**
 * The no-spinner observer (0002 §7), an init script: it records every loading marker the page ever shows, `aria-busy`
 * true or a progress bar, on `window.__busy`. Shows means paints: @smthrs/ui's loading pattern stays invisible for its
 * first LOADING_DELAY_MS, so a marker counts only once a frame draws it with every ancestor's opacity above 0. A
 * streaming answer's pending line, inside `[data-answer=streaming]`, is exempt, and so is the router's own bar
 * (`[data-placement=page]`), which shows only while a navigation waits on the network past that delay. The app has no
 * Suspense boundary, so no fallback can show.
 */
export const watchForSpinners = () => {
  const seen: Array<string> = []
  Object.assign(window, { __busy: seen })
  const busy = '[aria-busy="true"], [role="progressbar"]:not([data-placement="page"])'
  const watched = new WeakSet<Element>()
  const painted = (element: Element) => {
    if (element.getClientRects().length === 0) return false
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) === 0) return false
    }
    return true
  }
  // Each frame while the marker is still in the page and still busy: recorded the first frame it paints.
  const watch = (element: Element) => {
    if (!element.isConnected || !element.matches(busy)) return watched.delete(element)
    if (painted(element)) return seen.push(element.outerHTML.slice(0, 160))
    requestAnimationFrame(() => watch(element))
  }
  const check = (root: ParentNode) => {
    for (const element of root.querySelectorAll(busy)) {
      if (element.closest("[data-answer=streaming]") || watched.has(element)) continue
      watched.add(element)
      watch(element)
    }
  }
  addEventListener("DOMContentLoaded", () => {
    check(document)
    new MutationObserver(() => check(document)).observe(document, { subtree: true, childList: true, attributes: true })
  })
}

/** What the observer saw on `page`: empty when it never showed a loading state. */
export const spinnersSeen = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __busy?: Array<string> }).__busy ?? []).catch(() => [])

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)

const specOf = (testInfo: TestInfo) => basename(testInfo.file).replace(/\.spec\.ts$/, "")

// A flow's name, for its GIF: the spec file and the test title up to its colon, e.g. `chat-reload-mid-answer`.
export const flowName = (testInfo: TestInfo) => slug(`${specOf(testInfo)}-${testInfo.title.split(":")[0]!}`)

/** One recorded page: its label in the video, its file (relative to the manifest or absolute), and when it opened. */
export type Video = { readonly name: string; readonly video: string | undefined; readonly openedAt: number }

/**
 * Something a test did, for its video's chapters (e2e/frames.ts `chaptersOf`): a helper's `step`, with its end, or an
 * action a page saw. Times are ms since the epoch.
 */
export type Mark = { readonly start: number; readonly end?: number; readonly label: string }

const marks = new WeakMap<TestInfo, Array<Mark>>()
const marksOf = (testInfo: TestInfo) => {
  const list = marks.get(testInfo) ?? []
  marks.set(testInfo, list)
  return list
}

/**
 * A helper's user-visible action as a test step and a chapter of the test's video, named `title`. The actions inside
 * it are part of its chapter. A failure points at the test line that called the helper.
 */
export const step = <T>(title: string, body: () => Promise<T>): Promise<T> => {
  const list = marksOf(base.info())
  return base.step(
    title,
    async () => {
      const start = Date.now()
      try {
        return await body()
      } finally {
        list.push({ start, end: Date.now(), label: title })
      }
    },
    { box: true },
  )
}

/**
 * An init script for every frame: it reports each click, typing and key press the test drives (trusted events; the
 * app's own synthetic events are not), named by its target's accessible name, through `__e2eAction`.
 */
const watchActions = () => {
  const report = (label: string) => {
    const binding = (window as unknown as { __e2eAction?: (action: { label: string; at: number }) => Promise<unknown> }).__e2eAction
    if (typeof binding === "function") binding({ label, at: Date.now() }).catch(() => undefined)
  }
  const roles: Record<string, string> = { A: "link", BUTTON: "button", INPUT: "field", TEXTAREA: "field", SELECT: "menu", SUMMARY: "toggle", IFRAME: "frame" }
  const nameOf = (target: EventTarget | null) => {
    const start = target instanceof Element ? target : null
    const element = start?.closest("a, button, input, textarea, select, summary, iframe, [role], [aria-label], [contenteditable=true]") ?? start
    if (element === null || element === document.body || element === document.documentElement) return ""
    const text = (
      element.getAttribute("aria-label") ??
      element.getAttribute("title") ??
      element.getAttribute("placeholder") ??
      (element instanceof HTMLElement ? element.innerText : element.textContent) ??
      ""
    )
      .trim()
      .split("\n")[0]!
      .slice(0, 48)
    const role = element.getAttribute("role") ?? roles[element.tagName] ?? element.tagName.toLowerCase()
    return text === "" ? role : `"${text}" ${role}`
  }
  addEventListener("click", (event) => event.isTrusted && report(`Click ${nameOf(event.target) || "the page"}`), true)
  addEventListener("input", (event) => event.isTrusted && report(`Type in ${nameOf(event.target) || "the page"}`), true)
  addEventListener(
    "keydown",
    (event) => {
      const modified = event.ctrlKey || event.metaKey || event.altKey
      if (!event.isTrusted || (event.key.length === 1 && !modified) || ["Shift", "Control", "Meta", "Alt"].includes(event.key)) return
      const keys = [event.ctrlKey && "Control", event.metaKey && "Meta", event.altKey && "Alt", event.key].filter(Boolean).join("+")
      const name = nameOf(event.target)
      report(name === "" ? `Press ${keys}` : `Press ${keys} in ${name}`)
    },
    true,
  )
}

/**
 * Records what `page` does for the test's video chapters, before it loads anything: each navigation of its main frame,
 * and each click, typing and key press the test drives in any of its frames. `who` names the device in a test with
 * several. Every page a test drives needs it; the default page and the devices helpers' pages have it.
 */
export const recordActions = async (page: Page, testInfo: TestInfo, who = "") => {
  const prefix = who === "" ? "" : `${who}: `
  const list = marksOf(testInfo)
  await page.exposeBinding("__e2eAction", (_source, action: { label: string; at: number }) => {
    list.push({ start: action.at, label: `${prefix}${action.label}` })
  })
  await page.addInitScript(watchActions)
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame() || !frame.url().startsWith("http")) return
    const url = new URL(frame.url())
    list.push({ start: Date.now(), label: `${prefix}Open ${url.pathname}${url.search}` })
  })
}

/**
 * The mode a test runs and records in, light or dark, about half of each (e2e/frames.ts `themeFor`): the browser's
 * color scheme, which the app's theme setting follows while the device has no preference, so the very first frame is in
 * it. A test that needs a mode names it: `{ annotation: { type: "theme", description: "light" } }`.
 */
export const themeOf = (testInfo: TestInfo) => themeFor(specOf(testInfo), testInfo.title, testInfo.annotations)

/**
 * What a test proves, in one sentence, for its video's title card: the `summary` annotation a spec can set, as
 * `test("title", { annotation: { type: "summary", description: "…" } }, …)`. Without one, the card reads the title.
 */
export const summaryOf = (testInfo: TestInfo): string | undefined =>
  testInfo.annotations.find((annotation) => annotation.type === "summary")?.description

/**
 * Writes a test's media manifest (`file`, beside its videos) with what the test did (its `step`s and recorded
 * actions), and attaches it as `media`. e2e/gifs.mjs makes the test's video, chapters and GIF from it. `startedAt` is
 * when the recording started, in ms since the epoch; each video's `openedAt` is seconds after it. The video lands at
 * `videos/<spec>/<test>.mp4`, e.g. `videos/branch-workspace/branch-conversation.mp4`.
 */
export const writeManifest = async (
  testInfo: TestInfo,
  file: "flow.json" | "devices.json",
  startedAt: number,
  videos: ReadonlyArray<Video>,
  extra: Record<string, unknown> = {},
) => {
  const path = testInfo.outputPath(file)
  const manifest = {
    flow: flowName(testInfo),
    spec: specOf(testInfo),
    test: slug(testInfo.title.split(":")[0]!),
    title: testInfo.title,
    // The video's title card (e2e/frames.ts `titleCardOf`): the test's describe blocks, and the summary it set.
    describe: testInfo.titlePath.slice(1, -1),
    summary: summaryOf(testInfo),
    theme: themeOf(testInfo),
    status: testInfo.status,
    startedAt,
    ...extra,
    videos,
    marks: [...marksOf(testInfo)].sort((left, right) => left.start - right.start),
  }
  await writeFile(path, JSON.stringify(manifest, null, 2))
  await testInfo.attach("media", { path, contentType: "application/json" })
}

/** The videos of the contexts a test opened itself, under its output directory, each named by its folder. */
const ownVideos = async (testInfo: TestInfo): Promise<Array<Video>> =>
  (await readdir(testInfo.outputDir, { recursive: true }))
    .filter((path) => path.endsWith(".webm") && path.includes("/"))
    .sort()
    .map((path) => ({ name: dirname(path), video: join(testInfo.outputDir, path), openedAt: 0 }))

const writeLog = async (path: string, log: Array<string>) => {
  await writeFile(path, log.join("\n"))
  return path
}

// Every test keeps the browser's console and page errors; a failing test saves them as browser.log, with the list of
// server, console and page errors its browsers reported (e2e/watch.ts). It fails on each of those it didn't declare.
// Every test also writes flow.json beside its video, so e2e/gifs.mjs makes one video and GIF per flow. A test that
// opens its own contexts instead (repo.spec.ts "clone") leaves the default page blank: its manifest lists those
// contexts' videos.
/**
 * This worker's spend guard (e2e/spend.ts): in a deployment, once the run's answers spent its token budget, every later
 * test fails before it asks. It reads the conversation through `request`, signed in as the run.
 */
export const guardSpend = (() => {
  let open: () => Promise<APIRequestContext> = () => Promise.reject(new Error("the spend guard has no request context"))
  const guard = spendGuard({
    // Only a run that can ask spends: a Member, with its own conversation to ask in (e2e/target.ts).
    applies: () => target === "deployment" && meets("member") && meets("ownConversation"),
    budget: () => tokenBudget(process.env),
    since: () => runStartedAt(process.env),
    // Shown on the test, never failing it: the test reads the same conversation through the app.
    unread: (error) => base.info().annotations.push({ type: "spend unread", description: String(error).split("\n")[0]!.slice(0, 200) }),
    rows: async () => {
      const request = await open()
      try {
        return await allServerRows(request)
      } finally {
        await request.dispose()
      }
    },
  })
  return (opener: () => Promise<APIRequestContext>) => {
    open = opener
    return guard()
  }
})()

/**
 * A worker fixture every test uses: request errors never carry the session cookie (e2e/redact.ts). Patching the class
 * once covers `page.request`, `request` and every context a test opens.
 */
export const redactedRequests = [
  async ({ playwright }: { playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"] }, use: (value: void) => Promise<void>) => {
    const probe = await playwright.request.newContext()
    redactRequestErrors(probe)
    await probe.dispose()
    await use()
  },
  { scope: "worker", auto: true },
] as const

export const test = base.extend<{ browserLog: Array<string>; spendGuard: void; problems: Watched }, { redactedRequests: void }>({
  redactedRequests: [...redactedRequests],
  context: async ({ context, playwright, browserName, contextOptions, baseURL, colorScheme, ignoreHTTPSErrors, viewport }, use, testInfo) => {
    if (browserName !== "webkit") return use(context)
    const device = await persistent(playwright.webkit, {
      ...contextOptions, baseURL, colorScheme, ignoreHTTPSErrors, viewport,
      recordVideo: { dir: testInfo.outputPath("videos"), size: viewport ?? { width: 1280, height: 800 } },
    })
    try {
      await device.context.addCookies((await context.storageState()).cookies)
      await use(device.context)
    } finally {
      const videos = device.context.pages().filter((page) => page.url() !== "about:blank").map((page) => page.video())
      const saved = videos.map((video, index) => video?.saveAs(testInfo.outputPath(index === 0 ? "video.webm" : `video-${index}.webm`)))
      await device.close()
      await Promise.all(saved)
    }
  },
  // Every context the test opens, watched for server, console and page errors (e2e/watch.ts).
  problems: [...problems],
  // A deployment run stops asking once its answers spent the run's token budget (e2e/spend.ts).
  spendGuard: [async ({ playwright }, use) => use(await guardSpend(() => playwright.request.newContext())), { auto: true }],
  // The default page's mode, from its first frame: `themeOf`.
  colorScheme: async ({}, use, testInfo) => use(themeOf(testInfo)),
  browserLog: [
    async ({ page, problems }, use, testInfo) => {
      problems.watch(page.context())
      const startedAt = Date.now()
      await page.addInitScript(watchForSpinners)
      await recordActions(page, testInfo)
      const log: Array<string> = []
      recordConsole(page, log)
      page.on("pageerror", (error) => log.push(`pageerror: ${error.message}`))
      const crashes = watchCrashes(page, "default", log)
      await use(log)
      await crashes.stop()
      // A test that skipped from its body, by `requires` (e2e/target.ts), recorded nothing to keep.
      if (testInfo.status === "skipped") return
      const failures = crashes.failure === undefined ? [] : [crashes.failure]
      describeCrashes(testInfo, failures)
      expect.soft(failures, failures.join("\n") || "no page crashed").toEqual([])
      expect.soft(problems.check(testInfo, log), UNDECLARED).toEqual([])
      if (!page.isClosed() && crashes.failure === undefined) expect(await spinnersSeen(page), "the page never showed a loading state").toEqual([])
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("browser-log", { path: await writeLog(testInfo.outputPath("browser.log"), log), contentType: "text/plain" })
      }
      // Playwright saves the page's video as video.webm beside it once the test ends.
      const videos = page.url() === "about:blank" ? await ownVideos(testInfo) : [{ name: "", video: "video.webm", openedAt: 0 }]
      await writeManifest(testInfo, "flow.json", startedAt, videos)
    },
    { auto: true },
  ],
})

export { expect }

export { answerTo, messageIn, questionIn } from "./messages"
