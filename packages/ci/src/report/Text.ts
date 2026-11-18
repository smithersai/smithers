/**
 * The replay report as `smithers-ci` prints it: numbers and a bar chart, no
 * sentences. A mismatch is the first line whenever there is one, and every
 * mismatch is listed; nothing about a wrong verdict is summarised away. Each
 * commit has a line that says whether the CI passed or failed there, in the
 * baseline and in each mode; a commit whose own CI could not be replayed is
 * listed with the reason. A CI
 * job that was not replayed is counted beside the commits and listed with its
 * reasons, and so is what the inventory could not read, so the speedup is
 * never read as covering them. A tool this machine has at another version
 * than a job asks for is listed with both versions. Flaky verdicts are
 * counted beside the mismatches. On a repository that
 * already builds with Smithers build, the patterns replayed stand above the
 * speedup. When fast mode was asked for and could not be measured, a line says
 * so and why. The speedup covers the commits whose baseline passed and says so
 * when that is not all of them, and every step that failed is listed with its
 * exit code and the first line of its error output.
 *
 * Labels, reasons and commit ids come from the repository being replayed, so control
 * characters in them are replaced before they reach a terminal.
 *
 * @since 0.1.0
 */

import type { RenderReport } from "../contract/Parts.ts"
import type { ReplayCommit, RunTotals } from "../contract/ReplayReport.ts"
import {
  bar,
  commitsLeftOut,
  count,
  coverage,
  duration,
  failedSteps,
  failureText,
  fastNotMeasured,
  firstLine,
  flaky,
  leftEmpty,
  leftOut,
  mismatches,
  noSpeedup,
  ownTargets,
  ratio,
  reasons,
  shortCommit,
  speedup,
  speedupCommits,
  times,
  toolVersion,
  unread,
  verdict
} from "./Format.ts"

const width = 24

const paragraph = (lines: ReadonlyArray<string>): string => lines.join("\n")

const clean = (value: string): string => value.replace(/\p{Cc}/gu, "\uFFFD")

const way = (totals: RunTotals | undefined): string =>
  totals === undefined ? "" : `${verdict(totals.ok)} ${duration(totals.wallMs)}`

/** One line for each commit under a heading line: its changed files, and whether each way passed, with its time. */
const commitLines = (commits: ReadonlyArray<ReplayCommit>): ReadonlyArray<string> => {
  const withFast = commits.some((commit) => commit.fast !== undefined)
  const rows = [
    ["commit", "files", "baseline", "normal", ...(withFast ? ["fast"] : [])],
    ...commits.map((commit) => [
      clean(shortCommit(commit.commit)),
      String(commit.changedFiles),
      way(commit.baseline),
      way(commit.normal),
      ...(withFast ? [way(commit.fast)] : [])
    ])
  ]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) =>
    row.map((cell, column) => column === 1 ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)).join("  ")
      .trimEnd()
  )
}

/**
 * Renders a replay report for a terminal.
 *
 * @example
 * ```
 * 6.0× faster
 *
 * baseline  ████████████████████████  43m 40s
 * normal    ████                       7m 20s   6.0×
 * fast      █▍                         2m 30s  17.5×
 *
 * 2 commits · 0 mismatches
 *
 * commit   files  baseline      normal       fast
 * 3f2a1c9      3  pass 22m 00s  pass 4m 00s  pass 1m 30s
 * 8d1e0b2      1  fail 21m 40s  fail 3m 20s  fail 1m 00s
 * ```
 *
 * @category renderers
 * @since 0.1.0
 */
export const text: RenderReport = (report) => {
  const listed = report.commits.flatMap((commit) => commit.mismatches.map((mismatch) => ({ ...mismatch, commit })))
  const found = Math.max(report.mismatches, listed.length)
  const sections: Array<Array<string>> = []
  if (found > 0) sections.push([`✗ ${mismatches(found)}`])
  if (report.fastNotMeasured !== undefined) sections.push([clean(fastNotMeasured(report.fastNotMeasured))])
  if (report.commits.length === 0) return [...sections, [count(0, "commit")]].map(paragraph).join("\n\n")
  const modes = [
    { name: "baseline", ms: report.baselineWallMs, ratio: undefined },
    { name: "normal", ms: report.normalWallMs, ratio: report.speedup },
    ...(report.fastWallMs === undefined ?
      [] :
      [{ name: "fast", ms: report.fastWallMs, ratio: ratio(report.baselineWallMs, report.fastWallMs) }])
  ]
  const max = Math.max(...modes.map((mode) => mode.ms))
  const timeWidth = Math.max(...modes.map((mode) => duration(mode.ms).length))
  const ratioWidth = Math.max(...modes.map((mode) => (mode.ratio === undefined ? "" : times(mode.ratio)).length))
  if (report.targets !== undefined) sections.push([clean(ownTargets(report.targets))])
  if (speedupCommits(report) === 0) {
    sections.push([noSpeedup])
  } else {
    sections.push([`${speedup(report.speedup)} ${coverage(report)}`.trimEnd()])
    sections.push(modes.map((mode) =>
      [
        mode.name.padEnd(8),
        bar(mode.ms, max, width).padEnd(width),
        duration(mode.ms).padStart(timeWidth),
        ...(mode.ratio === undefined ? [] : [times(mode.ratio).padStart(ratioWidth)])
      ].join("  ")
    ))
  }
  const left = report.notReplayed ?? []
  const notRead = report.notRead ?? []
  const commitsLeft = report.notReplayedCommits ?? []
  sections.push([
    `${count(report.commits.length, "commit")} · ${mismatches(found)}${flaky(report.flaky ?? 0)}${
      commitsLeftOut(commitsLeft.length)
    }${leftOut(left.length)}${unread(notRead.length)}`
  ])
  sections.push([...commitLines(report.commits)])
  const failed = report.commits.flatMap((commit) => failedSteps(commit).map((entry) => ({ ...entry, commit })))
  if (failed.length > 0) {
    sections.push([
      "failed steps",
      ...failed.map(({ commit, failure, ways }) =>
        [clean(shortCommit(commit.commit)), ways.join(", "), clean(failure.step), clean(failureText(failure))].join(
          "  "
        )
      )
    ])
  }
  if (commitsLeft.length > 0) {
    sections.push([
      "commits not replayed",
      ...commitsLeft.map((entry) => `${clean(shortCommit(entry.commit))}  ${clean(firstLine(entry.reason))}`.trimEnd())
    ])
  }
  if (listed.length > 0) {
    // A mismatch over a file Smithers CI wrote says so on its own line, under the mismatch.
    sections.push(listed.flatMap((mismatch) => [
      [
        clean(shortCommit(mismatch.commit.commit)),
        mismatch.mode.padEnd(6),
        clean(mismatch.label),
        `${mismatch.baseline} → ${mismatch.got}`
      ].join("  "),
      ...(mismatch.cause === undefined ? [] : [`  ${clean(firstLine(mismatch.cause))}`])
    ]))
  }
  if (left.length > 0) {
    const jobWidth = Math.max(...left.map((entry) => clean(entry.job).length))
    sections.push(left.map((entry) => `${clean(entry.job).padEnd(jobWidth)}  ${clean(reasons(entry))}`.trimEnd()))
  }
  if (notRead.length > 0) {
    const featureWidth = Math.max(...notRead.map((entry) => clean(entry.feature).length))
    sections.push([
      "not read",
      ...notRead.map((entry) => `${clean(entry.feature).padEnd(featureWidth)}  ${clean(entry.detail)}`.trimEnd())
    ])
  }
  const tools = report.toolVersions ?? []
  if (tools.length > 0) {
    const jobWidth = Math.max(...tools.map((entry) => clean(entry.job).length))
    sections.push([
      "tool versions",
      ...tools.map((entry) => `${clean(entry.job).padEnd(jobWidth)}  ${clean(toolVersion(entry))}`)
    ])
  }
  const empty = report.withheld ?? []
  if (empty.length > 0) sections.push([clean(leftEmpty(empty))])
  return sections.map(paragraph).join("\n\n")
}
