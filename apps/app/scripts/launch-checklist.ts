/*
 * Launch checklist runner (Wave alpha-ui, U7): the headless, one-command
 * re-run of the signed-in launch checklist (§A-F) against ANY target origin.
 *
 * No origin is hardcoded here. The target is always explicit:
 *
 *   pnpm run checklist -- --target https://canary.smithers.sh   (repo root or apps/app)
 *   bun scripts/launch-checklist.ts --target http://127.0.0.1:8787
 *   CHECKLIST_TARGET=https://canary.smithers.sh bun scripts/launch-checklist.ts
 *   bun scripts/launch-checklist.ts --dry-run
 *
 * Every row in the catalog has a probe. The §A/§B/§C/§F rows and D-3/D-4's
 * pause half drive a real headless Chrome page on the target over the DevTools
 * protocol (scripts/headless-page.ts); the §D balance rows and the §E billing
 * upstream rows are HTTP. A row reports `not-testable-yet` only for a named,
 * specific reason — a missing auth env var, no browser on this machine, or a
 * fact the target's own state does not contain (an empty watched set) —
 * never as a blanket deferral.
 *
 * --dry-run makes zero network calls and launches no browser: it proves the
 * row catalog, the CLI wiring, and the report writer all work without any
 * target at all. Pointing --target at a local/unreachable origin (without
 * --dry-run) is "local mode": the probes really run and honestly report a
 * connection failure if nothing answers, which is how this wires up
 * post-deploy re-runs as one command without this lane touching live canary
 * traffic.
 *
 * The row catalog, the runner, and the CLI contract live under
 * scripts/launch-checklist/ and are covered by bun tests there; this file is the
 * process shell (clock, filesystem, browser, exit code).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { NO_BROWSER_REQUESTED_REASON } from "./launch-checklist/BrowserLaunch.ts"
import { HELP, NO_TARGET_ERROR, parseArgs, reportDir } from "./launch-checklist/Cli.ts"
import { ROWS } from "./launch-checklist/Rows.ts"
import { buildReport, exitCodeFor, renderMarkdown, runChecklist } from "./launch-checklist/Runner.ts"
import { BrowserUnavailableError, type ProbePage, type RowResult } from "./launch-checklist/Types.ts"
import { createHeadlessBrowser } from "./headless-page.ts"

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(HELP)
  process.exit(0)
}

const target = args.target ?? process.env.CHECKLIST_TARGET
if (!args.dryRun && (target === undefined || target === "")) {
  console.error(`${NO_TARGET_ERROR}\n`)
  console.error(HELP)
  process.exit(1)
}

const mode: "dry-run" | "run" = args.dryRun ? "dry-run" : "run"
const browser = mode === "dry-run" || args.noBrowser
  ? undefined
  : createHeadlessBrowser({ target: target as string, explicitBinary: args.browserPath, env: process.env })

const page = (cookie: string | undefined, signal?: AbortSignal): Promise<ProbePage> =>
  browser === undefined
    ? Promise.reject(new BrowserUnavailableError(NO_BROWSER_REQUESTED_REASON))
    : browser.page(cookie, signal)

const generatedAt = new Date().toISOString()
const outDir = reportDir(args, generatedAt)
let report = buildReport(mode, target, generatedAt, [])
const persist = (rows: ReadonlyArray<RowResult>): void => {
  report = buildReport(mode, target, generatedAt, rows)
  writeFileSync(`${outDir}/launch-checklist-report.json`, JSON.stringify(report, null, 2))
  writeFileSync(`${outDir}/launch-checklist-report.md`, renderMarkdown(report))
}
try {
  mkdirSync(outDir, { recursive: true })
  persist([])
  await runChecklist({
    rows: ROWS,
    mode,
    onProgress: persist,
    context: {
      target: target ?? "",
      env: process.env,
      page,
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      sleep: (ms, signal) => delay(ms, undefined, { signal })
    }
  })
} finally {
  await browser?.close()
}

for (const row of report.rows) {
  const marker = row.status === "pass" ? "ok" : row.status === "fail" ? "FAIL" : row.status.toUpperCase()
  console.log(`${marker}: [${row.id}] ${row.title}`)
}
console.log(
  `\nLAUNCH CHECKLIST (${mode}): ${report.totals.fail} fail · ${report.totals.pass} pass · ${report.totals.notTestableYet} not-testable-yet · ${report.totals.skippedDryRun} skipped-dry-run — report in ${outDir}`
)

process.exit(exitCodeFor(report.totals, mode))
