// The issue-tracking proof's cold waterfall (docs/features/work-links.md#the-proof): a cold issues list and a cold
// issue page on the proof's private repository, each in a fresh browser context (a new device: no OPFS, IndexedDB or
// HTTP cache, only the test account's session), with every stage on the page's timeline: the document, the app's
// scripts, the boot's stage marks (src/bootStages.ts), each `/api/` request's start and end, and when the first rows
// or the issue's title joined the document.
//
// One command: `E2E_PROD_URL=https://smithers.sh node e2e/prod.mjs e2e/issue-waterfall.spec.ts --project=deployment`.
// It writes test-results/issue-waterfall.json and prints one table per visit. Paths carry `<repo>` for the repository
// and the issue's number only; never a title, a body or a shape's rows.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Browser } from "@playwright/test"
import { expect, test } from "./fixtures"
import { baseURL, requires, sessionFiles } from "./target"

requires("trackingRepository")

const repo = process.env.E2E_TRACKING_REPOSITORY ?? ""
const [owner = "", name = ""] = repo.split("/")
/** Cold visits per page: the table reports each, and the median. */
const visits = Number(process.env.E2E_WATERFALL_VISITS ?? "3")
const numbersFile = join("test-results", "issue-waterfall.json")

/** One stage on a visit's timeline, in milliseconds from navigation. */
interface Stage { readonly name: string; readonly start: number; readonly end: number }

/** Installed before the page's scripts: when an element matching `selector` and holding `text` first shows, on `window.__shown`. */
function watchShown({ selector, text }: { selector: string; text: string }) {
  const marks = { shown: 0 }
  ;(window as unknown as { __shown: typeof marks }).__shown = marks
  const matches = () => Array.from(document.querySelectorAll(selector)).some((element) => (element.textContent ?? "").includes(text))
  new MutationObserver(() => {
    if (marks.shown === 0 && matches()) marks.shown = performance.now()
  }).observe(document, { childList: true, subtree: true, characterData: true })
  // The main thread's long tasks: a stage that waits on the page's own work, not the network, shows as one.
  const long: Array<{ start: number; duration: number }> = []
  ;(window as unknown as { __long: typeof long }).__long = long
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) long.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ type: "longtask", buffered: true })
}

/** The path of `url` with the repository as `<repo>`, and its query's keys with only short values kept. */
export const redactedPath = (url: string, repository: string): string => {
  const parsed = new URL(url)
  const path = parsed.pathname.replaceAll(repository, "<repo>").replaceAll(repository.toLowerCase(), "<repo>")
  const query = [...parsed.searchParams].map(([key, value]) =>
    key === "repo" ? `${key}=<repo>` : key === "number" || key === "offset" || key === "live" || key === "limit" ? `${key}=${value.slice(0, 24)}` : key
  )
  return query.length === 0 ? path : `${path}?${query.join("&")}`
}

const visit = async (browser: Browser, path: string, shown: { selector: string; text: string }): Promise<{ shown: number; stages: Array<Stage> }> => {
  const context = await browser.newContext({ storageState: sessionFiles(baseURL).session, baseURL, viewport: { width: 1280, height: 800 } })
  try {
    await context.addInitScript(watchShown, shown)
    const page = await context.newPage()
    // E2E_WATERFALL_PROFILE=<dir>: the main thread's CPU profile of each visit, for DevTools; code locations only.
    const profiling = process.env.E2E_WATERFALL_PROFILE
    const cdp = profiling === undefined ? undefined : await context.newCDPSession(page)
    if (cdp !== undefined) {
      await cdp.send("Profiler.enable")
      await cdp.send("Profiler.setSamplingInterval", { interval: 500 })
      await cdp.send("Profiler.start")
    }
    await page.goto(path, { waitUntil: "commit" })
    await page.waitForFunction(() => (window as unknown as { __shown: { shown: number } }).__shown.shown > 0, null, { timeout: 60_000 })
    if (cdp !== undefined) {
      const { profile } = await cdp.send("Profiler.stop")
      mkdirSync(profiling!, { recursive: true })
      writeFileSync(join(profiling!, `${path.split("/").slice(3).join("-") || "page"}-${Date.now()}.cpuprofile`), JSON.stringify(profile))
    }
    const timeline = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming
      const resources = performance.getEntriesByType("resource") as Array<PerformanceResourceTiming>
      const marks = performance.getEntriesByType("mark").filter((mark) => mark.name.startsWith("smithers.boot."))
      return {
        shown: (window as unknown as { __shown: { shown: number } }).__shown.shown,
        document: { start: navigation.startTime, end: navigation.responseEnd },
        resources: resources.map((entry) => ({ url: entry.name, type: entry.initiatorType, start: entry.startTime, end: entry.responseEnd, size: entry.transferSize })),
        marks: marks.map((mark) => ({ name: mark.name.slice("smithers.boot.".length), at: mark.startTime })),
        long: (window as unknown as { __long: Array<{ start: number; duration: number }> }).__long,
      }
    })
    const scripts = timeline.resources.filter((entry) => /\.(js|css|wasm)(\?|$)/.test(new URL(entry.url).pathname))
    const api = timeline.resources.filter((entry) => new URL(entry.url).pathname.startsWith("/api/") && entry.start <= timeline.shown)
    const stages: Array<Stage> = [
      { name: "document", ...timeline.document },
      ...(scripts.length === 0 ? [] : [{
        name: `assets (${scripts.length}, ${Math.round(scripts.reduce((total, entry) => total + entry.size, 0) / 1024)} KiB)`,
        start: Math.min(...scripts.map((entry) => entry.start)),
        end: Math.max(...scripts.map((entry) => entry.end)),
      }]),
      ...timeline.marks.map((mark) => ({ name: `boot.${mark.name}`, start: mark.at, end: mark.at })),
      ...api.map((entry) => ({ name: redactedPath(entry.url, repo), start: entry.start, end: entry.end })),
      ...timeline.long.filter((task) => task.duration >= 100 && task.start <= timeline.shown)
        .map((task) => ({ name: "main thread busy", start: task.start, end: task.start + task.duration })),
      { name: "shown", start: timeline.shown, end: timeline.shown },
    ]
    return { shown: Math.round(timeline.shown), stages: stages.sort((a, b) => a.start - b.start).map((stage) => ({ ...stage, start: Math.round(stage.start), end: Math.round(stage.end) })) }
  } finally {
    await context.close()
  }
}

const table = (label: string, stages: ReadonlyArray<Stage>) =>
  [label, ...stages.map((stage) => `  ${String(stage.start).padStart(6)} ${String(stage.end).padStart(6)} ${String(stage.end - stage.start).padStart(6)}  ${stage.name}`)].join("\n")

const median = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

const record = (phase: string, numbers: unknown) => {
  mkdirSync("test-results", { recursive: true })
  const all = existsSync(numbersFile) ? JSON.parse(readFileSync(numbersFile, "utf8")) : {}
  writeFileSync(numbersFile, JSON.stringify({ ...all, [phase]: { numbers, at: new Date().toISOString() } }, null, 2))
}

test("cold list: the issues list's first rows on a new device, stage by stage", async ({ browser, request }) => {
  test.setTimeout(10 * 60_000)
  const first = ((await (await request.get(`/api/repos/${owner}/${name}/issues?limit=1`)).json()) as Array<{ number: number }>)[0]!
  const runs = []
  for (let i = 0; i < visits; i++) {
    const run = await visit(browser, `/${repo}/issues`, { selector: `a[href$="/${repo}/issues/${first.number}"]`, text: "" })
    console.log(table(`cold list, visit ${i + 1}: first rows at ${run.shown} ms`, run.stages))
    runs.push(run)
  }
  record("list", { medianShownMs: median(runs.map((run) => run.shown)), runs })
  expect(runs.length).toBe(visits)
})

test("cold issue: one issue's title on a new device, stage by stage", async ({ browser, request }) => {
  test.setTimeout(10 * 60_000)
  // An issue past the list's first page, so nothing the list shows first helps it.
  const issues = (await (await request.get(`/api/repos/${owner}/${name}/issues?state=all&limit=100`)).json()) as Array<{ number: number }>
  const runs = []
  for (let i = 0; i < visits; i++) {
    const number = issues[50 + i]!.number
    // The heading holds the issue's number once its row arrived, as the proof's (a) waits for; a pending screen's doesn't.
    const run = await visit(browser, `/${repo}/issues/${number}`, { selector: "h1", text: `#${number}` })
    console.log(table(`cold issue #${number}, visit ${i + 1}: title at ${run.shown} ms`, run.stages))
    runs.push(run)
  }
  record("issue", { medianShownMs: median(runs.map((run) => run.shown)), runs })
  expect(runs.length).toBe(visits)
})
