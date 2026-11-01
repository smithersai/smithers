import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FridayBot, layer } from "../../../examples/use-cases/friday-bot.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "friday-bot-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, label: string) => new RegExp(`\\n${label}: (.*)`).exec(asked)![1]!

/**
 * A scheduler that goes weekly only when forced, collectors that report fixed
 * activity (Slack answers off-schema when `brokenSlack` is set), a summarizer
 * that derives its metrics from the digests it is handed, and a publisher that
 * names the message after the channel and headline it was handed. Every
 * request is recorded in order.
 */
const script = (brokenSlack = false) => {
  const turns: Array<string> = []
  const published: Array<unknown> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You determine the current reporting period")) {
      const weekly = field(asked, "Force weekly") === "true"
      turns.push(`schedule in ${field(asked, "Timezone")}`)
      return weekly
        ? { periodLabel: "Week of 2026-10-12", isWeekly: true, cutoffISO: "2026-10-12T00:00:00Z" }
        : { periodLabel: "2026-10-14", isWeekly: false, cutoffISO: "2026-10-13T00:00:00Z" }
    }
    if (asked.includes("You collect GitHub activity")) {
      turns.push(`github ${field(asked, "Repository")} since ${field(asked, "Since")}`)
      return { mergedPRs: 4, openPRs: 2, notableCommits: ["parser rewrite"], stalePRs: [] }
    }
    if (asked.includes("You collect Linear project-tracking data")) {
      turns.push(`linear ${field(asked, "Team")} since ${field(asked, "Since")}`)
      return {
        completedIssues: 6,
        inProgressIssues: 3,
        blockedIssues: [{ id: "ENG-9", title: "Upgrade the queue", blocker: "vendor outage" }],
        topLabels: ["backend"]
      }
    }
    if (asked.includes("You collect Slack activity highlights")) {
      turns.push(`slack ${field(asked, "Channels")} since ${field(asked, "Since")}`)
      return brokenSlack
        ? { activeThreads: "many" }
        : { activeThreads: 12, topTopics: ["launch"], unresolvedQuestions: [] }
    }
    if (asked.includes("You synthesize data from GitHub, Linear, and Slack")) {
      const [, cadence, period] = /Summarize the (weekly|daily) activity for (.+)\./.exec(asked)!
      const github = JSON.parse(field(asked, "GitHub"))
      const linear = JSON.parse(field(asked, "Linear"))
      turns.push(`summarize ${cadence} ${period}`)
      return {
        headline: `${github.mergedPRs} PRs shipped`,
        highlights: github.notableCommits,
        actionItems: linear.blockedIssues.map((b: { readonly id: string }) => ({
          action: `unblock ${b.id}`,
          priority: "high"
        })),
        risks: linear.blockedIssues.map((b: { readonly blocker: string }) => b.blocker),
        metrics: {
          prsShipped: github.mergedPRs,
          issuesClosed: linear.completedIssues,
          blockers: linear.blockedIssues.length
        }
      }
    }
    if (asked.includes("You publish the final summary")) {
      const summary = JSON.parse(field(asked, "Summary"))
      const channel = field(asked, "Channel")
      turns.push(`publish to ${field(asked, "Destination")} ${channel}`)
      published.push(summary)
      return { destination: field(asked, "Destination"), messageId: `${channel}:${summary.headline}`, success: true }
    }
    return undefined
  }
  return { answer, published, turns }
}

it.effect("collects all three sources from the period's cutoff, then summarizes and publishes", () =>
  Effect.gen(function*() {
    const { answer, published, turns } = script()
    const result = yield* Kit.run(FridayBot, {
      forceWeekly: true,
      repo: "acme/api",
      linearTeamId: "ENG",
      slackChannels: ["#eng"]
    }, {
      filename: join(directory, "weekly.sqlite"),
      executionId: "friday-bot-weekly",
      script: answer,
      actions: layer
    })

    // The scheduler ran first; the three collectors, in whatever order they
    // ran, all read its cutoff; the summary waited for all three.
    expect(turns[0]).toBe("schedule in America/Los_Angeles")
    expect(turns.slice(1, 4).sort()).toEqual([
      "github acme/api since 2026-10-12T00:00:00Z",
      "linear ENG since 2026-10-12T00:00:00Z",
      "slack [\"#eng\"] since 2026-10-12T00:00:00Z"
    ])
    expect(turns.slice(4)).toEqual(["summarize weekly Week of 2026-10-12", "publish to slack #team-updates"])
    // The publisher was handed the summary built from the three digests.
    expect(published).toEqual([{
      headline: "4 PRs shipped",
      highlights: ["parser rewrite"],
      actionItems: [{ action: "unblock ENG-9", priority: "high" }],
      risks: ["vendor outage"],
      metrics: { prsShipped: 4, issuesClosed: 6, blockers: 1 }
    }])
    expect(result).toEqual({ destination: "slack", messageId: "#team-updates:4 PRs shipped", success: true })
  }))

it.effect("stops before the summary when a collector fails", () =>
  Effect.gen(function*() {
    const { answer, published, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(FridayBot, { publishTo: "email", slackChannel: "#leads" }, {
      filename: join(directory, "collector-failed.sqlite"),
      executionId: "friday-bot-collector-failed",
      script: answer,
      actions: layer
    }))

    // A daily period by default; Slack's off-schema answer failed the run, as
    // 0.x's parallel group had no continue-on-fail.
    expect(turns).toContain("schedule in America/Los_Angeles")
    expect(turns).toContain("slack [] since 2026-10-13T00:00:00Z")
    expect(turns.some((turn) => turn.startsWith("summarize"))).toBe(false)
    expect(published).toEqual([])
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("StructuredOutputFailure")
  }))
