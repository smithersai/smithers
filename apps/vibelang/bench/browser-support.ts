// Stays .ts: shared by the Playwright benchmark specs (bench/browser.spec.ts, bench/browser-faults.spec.ts).
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { BrowserContext, Page } from "@playwright/test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { cpus, hostname, platform, release } from "node:os"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

export async function save(name: string, measurements: unknown, limitations: string[], options: { live: boolean; deploymentRevision: string | null; build?: { kind: string; minified: boolean }; method?: string }) {
  const { live, deploymentRevision } = options
  const timestamp = new Date().toISOString()
  // Packed measurement trees have no jj checkout; retain the commit supplied by the packing host.
  const local = await promisify(execFile)("jj", ["log", "--no-graph", "-r", "@", "-T", "commit_id"], { timeout: 30000 }).then((result) => result.stdout.trim(), () => undefined)
  const revision = local ?? (process.env.BENCH_REVISION ?? "").trim()
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Benchmark source revision is unavailable")
  const versions: Record<string, string> = {}
  for (const name of ["@playwright/test", "vibelang", "effect", "vitest"]) versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8")).version
  await mkdir("bench/results", { recursive: true })
  await writeFile(`bench/results/${timestamp.replaceAll(":", "-")}-${name}.json`, JSON.stringify({
    schema: 1, instrumented: process.env.BENCH_COVERAGE === "1", name, timestamp, localTime: new Date().toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    machine: { hostname: hostname(), platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    runtime: process.versions, versions, revision,
    deployment: { revision: live ? deploymentRevision : revision, identityMethod: live ? (deploymentRevision === null ? "Production does not expose its revision; unknown." : "Production /api/health commit at suite start.") : "Local build from this workspace revision." },
    build: options.build ?? (live ? { kind: "deployed", minified: null } : { kind: process.env.BENCH_COVERAGE === "1" ? "source-coverage" : "timing", minified: process.env.BENCH_COVERAGE !== "1" }),
    method: options.method ?? "Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed.",
    limitations, measurements,
  }, null, 2) + "\n", { flag: "wx" })
}

export async function collectBrowserCoverage(context: BrowserContext, page: Page, baseURL: string | undefined, name: string, options: { live: boolean; dist: string }) {
  // `options.dist` is the build the page was served from: the merge reads each script and its source map there.
  // Coverage mode only: the dump goes to the gate's own corpus (bench/merge-coverage.ts), never to Vitest's
  // subprocess pickup, so the separately bundled structure never merges with Node's structure of one source (0017).
  // Call the returned dump before every navigation as well as at the end: V8 precise coverage reports only the
  // current document's scripts, so a page left by page.goto loses its counts. Each dump resets the counters.
  // A navigation the page starts itself (⌘K's /mock loads `?agent=mock`) cannot be preceded by a call, so each
  // document also pauses in its own `beforeunload` while this session dumps, then resumes; the request is untouched.
  // Script that runs after `beforeunload` (the rest of the command that navigated) is lost: the new document's commit
  // ends a later pause (`pagehide` never pauses), so such lines need Node evidence (bench/web-commands.bench.vibe).
  if (process.env.BENCH_COVERAGE !== "1" || options.live) return undefined
  const directory = resolve("coverage/bench/chromium-raw")
  const session = await context.newCDPSession(page)
  await session.send("Profiler.enable")
  await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true })
  let sequence = 0
  let pausedFailure: unknown
  const dump = async () => {
    if (pausedFailure !== undefined) throw pausedFailure
    const raw = await session.send("Profiler.takePreciseCoverage")
    const result = raw.result.filter(entry => entry.url.startsWith(`${baseURL}/assets/`)).map(entry => ({ ...entry, url: pathToFileURL(resolve(options.dist, new URL(entry.url).pathname.slice(1))).href }))
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, `browser-${name}-${Date.now()}-${sequence++}.json`), JSON.stringify({ result }), { flag: "wx" })
  }
  await page.addInitScript(() => addEventListener("beforeunload", () => { debugger }))
  session.on("Debugger.paused", () => { void dump().catch(error => { pausedFailure ??= error }).finally(() => session.send("Debugger.resume").catch(error => { pausedFailure ??= error })) })
  await session.send("Debugger.enable")
  return dump
}
