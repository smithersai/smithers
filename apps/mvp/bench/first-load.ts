// `pnpm bench:first-load`: a cold, signed-out visit's first paint and first meaningful content, in real Chromium, against
// a deployment (BASE_URL=https://smithers.sh) or the local server, with the boot's stage marks (src/bootStages.ts).
// Fails when a route's median exceeds its budget on a built server (docs/benchmarks.md#first-load,
// docs/decisions/0108-first-load.md).
import { chromium, type Browser } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { summarize, type Summary } from "./stats.ts"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const RESULTS_DIR = `${HERE}first-load-results`
const CONTENT_TIMEOUT_MS = 60_000

/**
 * The budgets, in milliseconds from navigation, for the median cold visit: first contentful paint, and the route's
 * first meaningful content (its heading). On 2026-10-25 smithers.sh measured 8.3 to 8.7 s for both before decision 0108.
 * On 2026-10-26 the build before decision 0117 measured 2.3 and 3.3 s with assets served locally over HTTP/2, and its
 * own build 1.5 and 2.4 s: the budget fails a regression of the boot, such as the engine worker's fibers waiting on
 * nested timers again, not the network's noise.
 */
const BUDGET = { fcp: 3_000, content: 3_000 }

/**
 * The routes a launch visitor opens cold, each with the heading that is its first meaningful content: the landing's
 * wordmark, and the title of VibeLang's repository home. `--route <path>=<heading>` replaces them.
 */
const ROUTES: ReadonlyArray<Route> = [
  { path: "/", heading: "Smithers" },
  { path: "/smithersai/vibelang", heading: "VibeLang" },
]

type Route = { readonly path: string; readonly heading: string }

const fail = (message: string): never => {
  console.error(`bench:first-load: ${message}`)
  process.exit(2)
}

const { values: args } = parseArgs({
  options: {
    n: { type: "string", default: process.env.BENCH_N ?? "5" },
    route: { type: "string", multiple: true },
    "fcp-budget": { type: "string", default: String(BUDGET.fcp) },
    "content-budget": { type: "string", default: String(BUDGET.content) },
  },
})
const n = Number(args.n)
if (!Number.isInteger(n) || n < 1) fail(`--n must be a positive integer, got ${args.n}`)
const budget = { fcp: Number(args["fcp-budget"]), content: Number(args["content-budget"]) }
if (!(budget.fcp > 0) || !(budget.content > 0)) fail("budgets must be positive milliseconds")
const routes: ReadonlyArray<Route> = args.route === undefined ? ROUTES : args.route.map((spec) => {
  const at = spec.indexOf("=")
  if (!spec.startsWith("/") || at < 1) fail(`--route takes <path>=<heading>, got ${spec}`)
  return { path: spec.slice(0, at), heading: spec.slice(at + 1) }
})
const baseUrl = (process.env.BASE_URL ?? "http://localhost:1337").replace(/\/+$/, "")

/** What one cold visit measured, in milliseconds from navigation, and what it fetched before its content showed. */
type Visit = {
  readonly ttfb: number
  readonly fcp: number
  readonly content: number
  readonly stages: Record<string, number>
  readonly requestsBeforeContent: number
  readonly bytesBeforeContent: number
}

// Installed before the page's own scripts: when a heading named `heading` (its aria-label, else its text) first joins
// the document, and the first contentful paint, which waits for the page's web font.
function watchContent(heading: string) {
  const marks = { content: 0, fcp: 0 }
  ;(window as unknown as { __firstLoad: typeof marks }).__firstLoad = marks
  const shown = () =>
    Array.from(document.querySelectorAll("h1, h2, h3")).some((h) => (h.getAttribute("aria-label") || h.textContent?.trim()) === heading)
  new MutationObserver(() => {
    if (marks.content === 0 && shown()) marks.content = performance.now()
  }).observe(document, { childList: true, subtree: true, characterData: true })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") marks.fcp = entry.startTime
  }).observe({ type: "paint", buffered: true })
}

const visit = async (browser: Browser, route: Route): Promise<Visit> => {
  // A fresh context is a new device: no cookies, HTTP cache, service worker, OPFS or IndexedDB.
  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 800 } })
  try {
    await context.addInitScript(watchContent, route.heading)
    const page = await context.newPage()
    await page.goto(route.path, { waitUntil: "commit" })
    await page.waitForFunction(() => {
      const marks = (window as unknown as { __firstLoad: { content: number; fcp: number } }).__firstLoad
      return marks.content > 0 && marks.fcp > 0
    }, null, { timeout: CONTENT_TIMEOUT_MS })
    return await page.evaluate(() => {
      const { content, fcp } = (window as unknown as { __firstLoad: { content: number; fcp: number } }).__firstLoad
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
      const stages = Object.fromEntries(
        performance.getEntriesByType("mark").filter((mark) => mark.name.startsWith("smithers.boot."))
          .map((mark) => [mark.name.slice("smithers.boot.".length), Math.round(mark.startTime)]),
      )
      const before = (performance.getEntriesByType("resource") as Array<PerformanceResourceTiming>).filter((entry) => entry.responseEnd <= content)
      return {
        ttfb: Math.round(navigation?.responseStart ?? Number.NaN),
        fcp: Math.round(fcp),
        content: Math.round(content),
        stages,
        requestsBeforeContent: before.length,
        bytesBeforeContent: before.reduce((total, entry) => total + entry.transferSize, 0),
      }
    })
  } finally {
    await context.close()
  }
}

const run = (command: string, commandArgs: Array<string>) => {
  try {
    return execFileSync(command, commandArgs, { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

const main = async () => {
  const html = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(15_000) }).then((response) => response.text())
    .catch((error: unknown) => fail(`${baseUrl}/ is not answering (${String(error)})`))
  // Vite's dev client means unbundled dev modules: the numbers are reported, the budget isn't checked.
  const server = html.includes("/@vite/client") ? "vite-dev" : "built"
  const startedAt = new Date()
  const browser = await chromium.launch()
  const browserVersion = browser.version()
  const visits: Record<string, Array<Visit>> = Object.fromEntries(routes.map((route) => [route.path, []]))
  const failures: Array<{ route: string; iteration: number; error: string }> = []
  try {
    for (let iteration = 0; iteration < n; iteration++) {
      for (const route of routes) {
        try {
          visits[route.path]!.push(await visit(browser, route))
        } catch (error) {
          failures.push({ route: route.path, iteration, error: error instanceof Error ? error.message.split("\n")[0]! : String(error) })
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
  const summary = (values: ReadonlyArray<number>): Summary | null => {
    const finite = values.filter(Number.isFinite)
    return finite.length === 0 ? null : summarize(finite)
  }
  const report = Object.fromEntries(routes.map((route) => {
    const samples = visits[route.path]!
    const stageNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.stages)))]
    const fcp = summary(samples.map((sample) => sample.fcp))
    const content = summary(samples.map((sample) => sample.content))
    return [route.path, {
      heading: route.heading,
      fcp,
      content,
      ttfb: summary(samples.map((sample) => sample.ttfb)),
      stages: Object.fromEntries(stageNames.map((stage) => [stage, summary(samples.map((sample) => sample.stages[stage] ?? Number.NaN))])),
      requestsBeforeContent: summary(samples.map((sample) => sample.requestsBeforeContent)),
      bytesBeforeContent: summary(samples.map((sample) => sample.bytesBeforeContent)),
      withinBudget: fcp !== null && content !== null && fcp.p50 <= budget.fcp && content.p50 <= budget.content,
    }]
  }))
  const checked = server === "built"
  const ok = failures.length === 0 && (!checked || Object.values(report).every((route) => route.withinBudget))
  const result = {
    ok,
    budget: { ...budget, checked, statistic: "p50" },
    method: `${n} cold visits per route, each in a fresh Chromium context (no cookies, cache, service worker or device storage), signed out. FCP is Chromium's first-contentful-paint; content is when the route's heading joins the document; stages are the boot's smithers.boot.* marks. All in milliseconds from navigation.`,
    limitations: "One machine and one network path; headless Chromium; the content time is DOM insertion, which precedes its paint by a frame. Against a dev server the modules are unbundled and the budget is not checked.",
    env: {
      commit: run("jj", ["--ignore-working-copy", "log", "-r", "@", "-T", "commit_id", "--no-graph"]),
      baseUrl,
      server,
      machine: { cpu: os.cpus()[0]?.model ?? null, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30) },
      os: `${os.type()} ${os.release()}, ${os.arch()}`,
      browser: `Chromium ${browserVersion} (headless)`,
      playwright: createRequire(import.meta.url)("@playwright/test/package.json").version as string,
      node: process.version,
      date: startedAt.toISOString(),
      n,
    },
    routes: report,
    failures,
    samples: visits,
  }
  await mkdir(RESULTS_DIR, { recursive: true })
  const path = `${RESULTS_DIR}/${startedAt.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.json`
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  for (const [route, measured] of Object.entries(report)) {
    const fcp = measured.fcp === null ? "none" : `${measured.fcp.p50} ms`
    const content = measured.content === null ? "none" : `${measured.content.p50} ms`
    const verdict = !checked ? "not checked (dev server)" : measured.withinBudget ? "within budget" : "OVER BUDGET"
    console.log(`${route}: FCP p50 ${fcp} / ${budget.fcp} ms, content p50 ${content} / ${budget.content} ms: ${verdict}`)
  }
  for (const failure of failures) console.log(`${failure.route} #${failure.iteration}: ${failure.error}`)
  console.log(`bench:first-load: ${path}`)
  process.exit(ok ? 0 : 1)
}

await main()
