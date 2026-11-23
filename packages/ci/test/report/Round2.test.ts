/**
 * The report of a replay that completed no commit still says why each commit was left out, and two failures of one
 * step are one entry only when they agree in exit code and in reason.
 */

import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { type ReplayCommit, ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { failedSteps } from "../../src/report/Format.vibe"
import { html, text } from "../../src/report/index.vibe"

const example: ReplayReport = Schema.decodeUnknownSync(ReplayReport)(
  JSON.parse(readFileSync(new URL("../fixtures/replay-report.example.json", import.meta.url), "utf8"))
)

const [green] = example.commits as [ReplayCommit, ReplayCommit]

const none: ReplayReport = {
  version: 1,
  repository: "example/repo",
  commits: [],
  baselineWallMs: 0,
  normalWallMs: 0,
  speedup: 0,
  mismatches: 0
}

describe("a report with no replayed commit", () => {
  const skipped: ReplayReport = {
    ...none,
    notReplayedCommits: [
      {
        commit: "0123456789abcdef",
        reason: "0 of 1 CI job can be reproduced on this machine\n  ci.yml:deploy  secret"
      },
      { commit: "fedcba9876543210", reason: "te\u001bst <b>" }
    ]
  }

  it("lists in the text each commit that was left out, with the first line of why", () => {
    expect(text(skipped).split("\n")).toEqual([
      "0 commits",
      "",
      "commits not replayed",
      "0123456  0 of 1 CI job can be reproduced on this machine",
      "fedcba9  te�st <b>"
    ])
  })

  it("lists them on the page, after the count", () => {
    const page = html(skipped)
    expect(page).toContain("<p class=\"summary\">0 commits</p>\n<h2>Commits not replayed</h2>")
    expect(page).toContain(
      "<tr><th scope=\"row\"><code title=\"0123456789abcdef\">0123456</code></th><td class=\"sub\">0 of 1 CI job can be reproduced on this machine</td></tr>"
    )
    expect(page).toContain("te\u001bst &lt;b&gt;")
  })

  it("says nothing of left-out commits when there is none", () => {
    for (const report of [none, { ...none, notReplayedCommits: [] }]) {
      expect(text(report)).toBe("0 commits")
      expect(html(report)).not.toContain("Commits not replayed")
    }
  })
})

describe("the failed steps of a commit", () => {
  const { fast: _fast, model: _model, skipped: _skipped, ...plain } = green
  const failed = (failures: ReadonlyArray<{ step: string; reason: string; exitCode?: number }>) => ({
    ...green.baseline,
    ok: false,
    failures
  })

  it("keeps two failures of one step with one exit code and different reasons apart", () => {
    const commit: ReplayCommit = {
      ...plain,
      baseline: failed([{ step: "build", exitCode: 1, reason: "error TS2322: not assignable" }]),
      normal: failed([{ step: "build", exitCode: 1, reason: "src/a.ts: no such file" }])
    }
    expect(failedSteps(commit).map((entry) => [entry.ways, entry.failure.reason])).toEqual([
      [["baseline"], "error TS2322: not assignable"],
      [["normal"], "src/a.ts: no such file"]
    ])
  })

  it("is one entry for the ways that failed alike, with or without an exit code", () => {
    const coded = { step: "build", exitCode: 1, reason: "error TS2322: not assignable" }
    const bare = { step: "wait", reason: "it made no progress for 10 minutes" }
    const commit: ReplayCommit = {
      ...plain,
      baseline: failed([coded, bare]),
      normal: failed([coded, bare, { ...bare, exitCode: 1 }, { ...coded, exitCode: 2 }]),
      fast: failed([coded])
    }
    expect(failedSteps(commit).map((entry) => [entry.ways, entry.failure.step, entry.failure.exitCode])).toEqual([
      [["baseline", "normal", "fast"], "build", 1],
      [["baseline", "normal"], "wait", undefined],
      [["normal"], "wait", 1],
      [["normal"], "build", 2]
    ])
  })
})
