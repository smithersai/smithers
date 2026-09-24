/*
 * The canary alert decision (CN-20's "with an alert", CN-21's schedule).
 *
 *   bun scripts/canary/uptime-report.ts --report <path> [options]
 *
 *     --open-issue <n>      the number of the alert issue that is already open
 *     --run-url <url>       the Actions run to link from the issue
 *     --body-out <path>     write the issue body here (gh --body-file reads it)
 *     --browser <path>      the browser probe's result.json. Given on every run
 *                           whose browser step ran; absent means the browser
 *                           recheck is pending (the quarter-hour ticks)
 *     --force-fail <reason> add a deliberate failing row: the alert drill
 *     --github-output <path>  write action/issue/title/assignees (defaults to $GITHUB_OUTPUT)
 *
 * There is no paging infrastructure in this project and this file invents
 * none. The alert is one GitHub issue under a fixed title: a failing run opens
 * it, later failing runs comment on it, and the first passing run comments and
 * closes it. `gh` is left to the workflow; the decision is made here, where
 * uptime-checks.test.ts covers it.
 *
 * A missing or unreadable report is itself an alert. `coerceReport` turns it
 * into a failing report, so a probe that crashed before writing anything still
 * opens an issue rather than passing silently. `browserVerdict` does the same
 * for a browser result.json that a full run should have written.
 *
 * Checks that were not measured are printed as one ::warning line, so a green
 * run says what it did not measure.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { argReader } from "./CanaryArgs.ts"
import {
  ALERT_TITLE,
  alertAction,
  browserVerdict,
  type Check,
  coerceReport,
  drillCheck,
  renderAlertBody,
  withChecks
} from "./uptime-checks.ts"

const args = process.argv.slice(2)
/* A flag left empty is refused before the report is read or any file written. */
const flagValue = argReader(args, (detail) => {
  console.error(`uptime-report.ts: ${detail}`)
  process.exit(2)
})

const reportPath = flagValue("--report")
if (reportPath === undefined) {
  console.error("uptime-report.ts: --report <path> is required")
  process.exit(2)
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}
const browserPath = flagValue("--browser")
const forceFail = flagValue("--force-fail")
const extra: ReadonlyArray<Check> = [
  ...(browserPath === undefined ? [] : [browserVerdict(readJson(browserPath), browserPath)]),
  ...(forceFail === undefined ? [] : [drillCheck(forceFail)])
]
const report = withChecks(coerceReport(readJson(reportPath), reportPath), extra)

const rawIssue = flagValue("--open-issue")
const openIssue = rawIssue === undefined || rawIssue.trim() === "" ? undefined : Number(rawIssue)
if (openIssue !== undefined && !Number.isInteger(openIssue)) {
  console.error(`uptime-report.ts: --open-issue must be an integer, got ${rawIssue}`)
  process.exit(2)
}

const runUrl = flagValue("--run-url") ?? "(no run url given)"
const action = alertAction({ report, openIssue, runUrl, browserPending: browserPath === undefined })

const bodyOut = flagValue("--body-out")
if (bodyOut !== undefined) {
  writeFileSync(bodyOut, `${action.kind === "none" ? renderAlertBody(report, runUrl) : action.body}\n`)
}

const outputPath = flagValue("--github-output") ?? process.env.GITHUB_OUTPUT
if (outputPath !== undefined && outputPath !== "") {
  const issue = action.kind === "comment" || action.kind === "close" ? String(action.issue) : ""
  const assignees = action.kind === "create" ? action.assignees.join(",") : ""
  writeFileSync(outputPath, `action=${action.kind}\nissue=${issue}\ntitle=${ALERT_TITLE}\nassignees=${assignees}\n`, {
    flag: "a"
  })
}

const unmeasured = report.checks.filter((check) => check.status === "skip")
if (unmeasured.length > 0) {
  const lines = unmeasured.map((check) => `${check.label}: ${check.detail}`)
  console.log(`::warning title=Canary did not measure::${lines.join(" | ")}`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary !== undefined && summary !== "") {
    appendFileSync(summary, `### Not measured\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`)
  }
}

console.log(
  action.kind === "none"
    ? `alert: none — ${action.reason}`
    : `alert: ${action.kind}${action.kind === "create" ? "" : ` on issue #${String(action.issue)}`}`
)

/*
 * The exit code carries the canary's verdict, and this step is the last one in
 * the job. A failing canary therefore leaves the issue behind BEFORE the job
 * goes red, which is the whole point of deciding the alert here rather than
 * letting the probe's own exit code fail the job first.
 */
process.exit(report.failed ? 1 : 0)
