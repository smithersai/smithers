/**
 * The replay report as one HTML file a person opens on any device. It holds
 * its own styles and no script, and its content security policy refuses every
 * network request, so the file reads the same offline as attached to a CI run.
 *
 * Every string from the repository (its name, commit ids, target labels) is
 * escaped: a label is data, never markup.
 *
 * @since 0.1.0
 */

import type { NotReplayed, ToolVersion, Unsupported } from "../contract/Inventory.ts"
import type { RenderReport } from "../contract/Parts.ts"
import type {
  Mismatch,
  NotReplayedCommit,
  ReplayCommit,
  ReplayReport,
  RunnerStep,
  RunTotals
} from "../contract/ReplayReport.ts"
import {
  appliedTime,
  coldStart,
  commitsLeftOut,
  count,
  coverage,
  cpuTime,
  diskHeld,
  duration,
  type FailedStep,
  failedSteps,
  failureText,
  fastNotMeasured,
  firstLine,
  firstRunTime,
  flaky,
  jobsCount,
  jobsLeftOut,
  leftEmpty,
  leftOut,
  mismatches,
  modelCost,
  modelTime,
  normalDiffers,
  noSpeedup,
  noSpeedupMismatch,
  ownTargets,
  ratio,
  reasons,
  recordedBy,
  rerunTime,
  selectionRows,
  shortCommit,
  skipGroups,
  skippedHeading,
  skippedLabels,
  speedup,
  speedupCommits,
  startCost,
  stoppedEarly,
  times,
  toolVersion,
  trialTime,
  unread,
  unreadText,
  verdict
} from "./Format.ts"

const entities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}

const escape = (value: string): string => value.replace(/[&<>"']/g, (character) => entities[character]!)

const style = `
:root{color-scheme:light;--surface:#fcfcfb;--text:#0b0b0b;--muted:#52514e;--line:#dcdbd6;
--baseline:#8a8984;--normal:#2a78d6;--fast:#eb6834;--critical:#d03b3b}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--surface:#1a1a19;--text:#f0efec;
--muted:#c3c2b7;--line:#383835;--baseline:#8a8984;--normal:#3987e5;--fast:#d95926}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:48rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{margin:0;font-size:1rem;font-weight:600;color:var(--muted);overflow-wrap:anywhere}
h2{margin:2rem 0 .5rem;font-size:1rem;font-weight:600}
.alert{margin:1rem 0 0;padding:.5rem .75rem;border:2px solid var(--critical);border-radius:6px;font-weight:600}
.alert::before{content:"✗ ";color:var(--critical)}
.hero{margin:.5rem 0 1.25rem;font-size:3rem;font-weight:600;line-height:1.1}
.bars{display:grid;grid-template-columns:auto 1fr auto auto;gap:2px .75rem;align-items:center}
.track{height:1.25rem}
.fill{display:block;height:100%;min-width:2px;border-radius:0 4px 4px 0}
.baseline{background:var(--baseline)}.normal{background:var(--normal)}.fast{background:var(--fast)}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.sub{color:var(--muted)}
.summary{margin:1.25rem 0 0;color:var(--muted)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{padding:.4rem .5rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted);white-space:nowrap}
tr.lead td{border-bottom:0}
tr.bad td:first-child{box-shadow:inset 3px 0 var(--critical)}
code{font:.875rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
ul{margin:0;padding:0;list-style:none}
`.trim()

const head = (title: string): string =>
  [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"color-scheme\" content=\"light dark\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    `<title>${escape(title)}</title>`,
    `<style>${style}</style>`,
    "</head>"
  ].join("\n")

interface Mode {
  readonly name: "baseline" | "normal" | "fast"
  readonly ms: number
  readonly ratio: number | undefined
}

const bars = (modes: ReadonlyArray<Mode>): string => {
  const max = Math.max(...modes.map((mode) => mode.ms))
  const rows = modes.map((mode) => {
    const share = max > 0 ? (mode.ms / max) * 100 : 0
    const label = `${mode.name} ${duration(mode.ms)}${mode.ratio === undefined ? "" : ` · ${times(mode.ratio)}`}`
    return [
      `<span>${mode.name}</span>`,
      `<span class="track" title="${label}"><span class="fill ${mode.name}" style="width:${
        share.toFixed(2)
      }%"></span></span>`,
      `<span class="num">${duration(mode.ms)}</span>`,
      `<span class="num sub">${mode.ratio === undefined ? "" : times(mode.ratio)}</span>`
    ].join("")
  })
  return `<div class="bars" role="img" aria-label="${
    modes.map((mode) => `${mode.name} ${duration(mode.ms)}`).join(", ")
  }">\n${rows.join("\n")}\n</div>`
}

/** Fast mode's three numbers with their counts, then what the model was asked and what that cost. */
const selection = (report: ReplayReport): string => {
  const cost = modelCost(report)
  return [
    "<h2>Fast mode</h2>",
    "<div class=\"scroll\"><table>",
    selectionRows(report.selection!).map((row) =>
      `<tr><th scope="row">${row.name}</th><td class="num">${row.share}</td><td class="num sub">${row.counts}</td></tr>`
    ).join("\n"),
    "</table></div>",
    report.model === undefined ? "" : `<p class="summary">${modelTime(report.model)}</p>`,
    cost === undefined ? "" : `<p class="summary">${cost}</p>`
  ].join("")
}

/** Every target fast mode skipped: its commit, how many, the model's reason, and the targets. */
const skippedTable = (commits: ReadonlyArray<ReplayCommit>): string =>
  [
    `<h2>${skippedHeading}</h2>`,
    "<div class=\"scroll\"><table>",
    ...skipGroups(commits).map((group) =>
      `<tr><th scope="row"><code title="${escape(group.commit)}">${
        escape(shortCommit(group.commit))
      }</code></th><td class="num">${group.labels.length}</td><td class="sub">${escape(group.reason)}</td><td><code>${
        escape(skippedLabels(group.labels))
      }</code></td></tr>`
    ),
    "</table></div>"
  ].join("\n")

/** A run's time, led by `fail` when the run failed: a time alone would read as a passing run. */
const time = (totals: RunTotals | undefined): string =>
  `<td class="num">${
    totals === undefined
      ? ""
      : `${totals.ok ? "" : `<span class="sub">${verdict(totals.ok)}</span> `}${duration(totals.wallMs)}`
  }</td>`

const mismatchItem = (mismatch: Mismatch): string =>
  `<li><code>${
    escape(mismatch.label)
  }</code> <span class="sub">${mismatch.mode}: ${mismatch.baseline} → ${mismatch.got}</span>${
    mismatch.cause === undefined ? "" : `<br>${escape(mismatch.cause)}`
  }</li>`

const failureItem = ({ failure, ways }: FailedStep): string =>
  `<li><code>${escape(failure.step)}</code> <span class="sub">${ways.join(", ")}: ${
    escape(failureText(failure))
  }</span>${failure.fix === undefined ? "" : `<br>${escape(failure.fix)}`}</li>`

/**
 * A commit's times on one row, and its mismatches and failed steps on a
 * full-width row under it, so a narrow screen never scrolls them out of sight.
 */
const commitRows = (commit: ReplayCommit, withFast: boolean): string => {
  const cells = [
    `<td><code title="${escape(commit.commit)}">${escape(shortCommit(commit.commit))}</code></td>`,
    time(commit.baseline),
    time(commit.normal),
    withFast ? time(commit.fast) : ""
  ].join("")
  const items = [...commit.mismatches.map(mismatchItem), ...failedSteps(commit).map(failureItem)]
  if (items.length === 0) return `<tr>${cells}</tr>`
  return `<tr class="bad lead">${cells}</tr>\n<tr class="bad"><td colspan="${withFast ? 4 : 3}"><ul>${
    items.join("")
  }</ul></td></tr>`
}

const notReplayedTable = (left: ReadonlyArray<NotReplayed>): string =>
  [
    "<h2>Not replayed</h2>",
    "<div class=\"scroll\"><table>",
    ...left.map((entry) =>
      `<tr><th scope="row"><code>${escape(entry.job)}</code></th><td class="sub">${escape(reasons(entry))}</td></tr>`
    ),
    "</table></div>"
  ].join("\n")

const runnerStepsTable = (steps: ReadonlyArray<RunnerStep>): string =>
  [
    "<h2>Not run here: your runner runs them, in the workflow apply writes</h2>",
    "<div class=\"scroll\"><table>",
    ...steps.map((entry) =>
      `<tr><th scope="row"><code>${escape(entry.job)}</code></th><td class="sub"><code>${
        escape(entry.action)
      }</code>: ${escape(entry.why)}</td></tr>`
    ),
    "</table></div>"
  ].join("\n")

const stepsLeftOutTable = (steps: ReadonlyArray<RunnerStep>): string =>
  [
    "<h2>Left out of the workflow apply writes: its job was replayed without it</h2>",
    "<div class=\"scroll\"><table>",
    ...steps.map((entry) =>
      `<tr><th scope="row"><code>${escape(entry.job)}</code></th><td class="sub"><code>${escape(entry.action)}</code> ${
        escape(entry.why)
      }</td></tr>`
    ),
    "</table></div>"
  ].join("\n")

const commitsLeftTable = (entries: ReadonlyArray<NotReplayedCommit>): string =>
  [
    "<h2>Commits not replayed</h2>",
    "<div class=\"scroll\"><table>",
    ...entries.map((entry) =>
      `<tr><th scope="row"><code title="${escape(entry.commit)}">${
        escape(shortCommit(entry.commit))
      }</code></th><td class="sub">${escape(firstLine(entry.reason))}</td></tr>`
    ),
    "</table></div>"
  ].join("\n")

const notReadTable = (entries: ReadonlyArray<Unsupported>): string =>
  [
    "<h2>Not read</h2>",
    "<div class=\"scroll\"><table>",
    ...entries.map((entry) => `<tr><td class="sub">${escape(unreadText(entry))}</td></tr>`),
    "</table></div>"
  ].join("\n")

const toolVersionsTable = (entries: ReadonlyArray<ToolVersion>): string =>
  [
    "<h2>Tool versions</h2>",
    "<div class=\"scroll\"><table>",
    ...entries.map((entry) =>
      `<tr><th scope="row"><code>${escape(entry.job)}</code></th><td class="sub">${
        escape(toolVersion(entry))
      }</td></tr>`
    ),
    "</table></div>"
  ].join("\n")

const commitTable = (commits: ReadonlyArray<ReplayCommit>): string => {
  const withFast = commits.some((commit) => commit.fast !== undefined)
  return [
    "<h2>Commits</h2>",
    "<div class=\"scroll\"><table>",
    `<thead><tr><th>commit</th><th class="num">baseline</th><th class="num">normal</th>${
      withFast ? "<th class=\"num\">fast</th>" : ""
    }</tr></thead>`,
    `<tbody>\n${commits.map((commit) => commitRows(commit, withFast)).join("\n")}\n</tbody>`,
    "</table></div>"
  ].join("\n")
}

/**
 * Renders a replay report as one self-contained HTML page, light and dark,
 * readable on a phone: the speedup, a bar per mode, fast mode's recall and
 * selection rate with the counts behind them, one row per commit with its
 * times, `fail` beside the time of a run that failed, its mismatches and
 * failed steps, the jobs not replayed and what was not read. The speedup covers
 * the commits whose baseline passed and says so when that is not all of them.
 *
 * @category renderers
 * @since 0.1.0
 */
export const html: RenderReport = (report) => {
  const found = Math.max(report.mismatches, report.commits.reduce((sum, commit) => sum + commit.mismatches.length, 0))
  const body: Array<string> = [`<h1>${escape(report.repository)}</h1>`]
  if (found > 0) body.push(`<p class="alert" role="alert">${mismatches(found)}</p>`)
  if (report.fastNotMeasured !== undefined) {
    body.push(`<p class="summary">${escape(fastNotMeasured(report.fastNotMeasured))}</p>`)
  }
  if (report.stopped !== undefined) {
    body.push(`<p class="alert" role="alert">${escape(stoppedEarly(report.stopped))}</p>`)
  }
  if (report.commits.length === 0) {
    body.push(`<p class="summary">${count(0, "commit")}</p>`)
  } else {
    const modes: Array<Mode> = [
      { name: "baseline", ms: report.baselineWallMs, ratio: undefined },
      { name: "normal", ms: report.normalWallMs, ratio: report.speedup }
    ]
    if (report.fastWallMs !== undefined) {
      modes.push({ name: "fast", ms: report.fastWallMs, ratio: ratio(report.baselineWallMs, report.fastWallMs) })
    }
    if (report.targets !== undefined) {
      body.push(`<p class="summary"><code>${escape(ownTargets(report.targets))}</code></p>`)
    }
    if (speedupCommits(report) === 0) {
      body.push(`<p class="alert" role="alert">${normalDiffers(report) ? noSpeedupMismatch : noSpeedup}</p>`)
    } else {
      body.push(`<p class="hero">${speedup(report.speedup)}</p>`)
      if (coverage(report) !== "") body.push(`<p class="summary">${coverage(report)}</p>`)
      body.push(bars(modes))
    }
    const left = report.notReplayed ?? []
    const notRead = report.notRead ?? []
    const commitsLeft = report.notReplayedCommits ?? []
    body.push(
      `<p class="summary">${count(report.commits.length, "commit")}${jobsCount(report)} · ${mismatches(found)}${
        flaky(report.flaky ?? 0)
      }${commitsLeftOut(commitsLeft.length)}${leftOut(jobsLeftOut(report))}${unread(notRead.length)}</p>`
    )
    if (report.recorder !== undefined) body.push(`<p class="summary">${escape(recordedBy(report.recorder))}</p>`)
    const cpu = cpuTime(report)
    if (cpu !== undefined) body.push(`<p class="summary">${cpu}</p>`)
    if (report.trialMs !== undefined) body.push(`<p class="summary">${trialTime(report.trialMs)}</p>`)
    if (report.appliedMs !== undefined) body.push(`<p class="summary">${appliedTime(report.appliedMs)}</p>`)
    if (report.firstRun !== undefined) body.push(`<p class="summary">${firstRunTime(report.firstRun)}</p>`)
    if (report.startCost !== undefined) {
      body.push(`<p class="summary">${startCost(report.startCost, report.commits)}</p>`)
    }
    if (report.cold !== undefined) body.push(`<p class="summary">${escape(coldStart(report.cold))}</p>`)
    if (report.reruns !== undefined) body.push(`<p class="summary">${rerunTime(report.reruns)}</p>`)
    if (report.diskHeldBytes !== undefined) body.push(`<p class="summary">${diskHeld(report.diskHeldBytes)}</p>`)
    if (report.selection !== undefined) body.push(selection(report))
    body.push(commitTable(report.commits))
    if (skipGroups(report.commits).length > 0) body.push(skippedTable(report.commits))
    if (commitsLeft.length > 0) body.push(commitsLeftTable(commitsLeft))
    if (left.length > 0) body.push(notReplayedTable(left))
    if (notRead.length > 0) body.push(notReadTable(notRead))
    const tools = report.toolVersions ?? []
    if (tools.length > 0) body.push(toolVersionsTable(tools))
    const runner = report.runnerSteps ?? []
    if (runner.length > 0) body.push(runnerStepsTable(runner))
    const unkept = report.stepsLeftOut ?? []
    if (unkept.length > 0) body.push(stepsLeftOutTable(unkept))
    const empty = report.withheld ?? []
    if (empty.length > 0) body.push(`<p class="summary">${escape(leftEmpty(empty))}</p>`)
  }
  return `${head(`${report.repository} · Smithers CI`)}\n<body>\n<main>\n${
    body.join("\n")
  }\n</main>\n</body>\n</html>\n`
}
