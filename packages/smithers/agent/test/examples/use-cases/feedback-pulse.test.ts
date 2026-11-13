import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FeedbackPulse, layer } from "../../../examples/use-cases/feedback-pulse.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "feedback-pulse-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

interface Raw {
  readonly id: string
  readonly text: string
}

/**
 * An intake that keeps every raw item, an analyst that calls any item
 * mentioning data loss a critical pain point, and a router that opens an
 * urgent alert and a ticket per critical pain point it is handed. Every
 * request is recorded in order. `brokenAnalyst` makes the analyst answer
 * off-schema.
 */
const script = (brokenAnalyst = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("Normalize this raw customer feedback")) {
      const feedback = JSON.parse(field(asked, "Feedback")) as ReadonlyArray<Raw>
      turns.push(
        `intake: ${feedback.length} items, sources ${field(asked, "Sources")}, range ${field(asked, "Date range")}`
      )
      return {
        items: feedback.map((raw) => ({ id: raw.id, source: "survey", text: raw.text, timestamp: "2026-10-01" })),
        totalCount: feedback.length,
        dateRange: { from: "2026-10-01", to: "2026-10-07" },
        summary: `${feedback.length} responses`
      }
    }
    if (asked.includes("You are a customer feedback analyst")) {
      const items = JSON.parse(field(asked, "Items")) as ReadonlyArray<Raw>
      turns.push(`extract: ${items.map((item) => item.id).join(",")} of ${field(asked, "Total count")}`)
      if (brokenAnalyst) return { unexpected: true }
      const lost = items.filter((item) => item.text.includes("data loss"))
      return {
        sentimentBreakdown: { positive: items.length - lost.length, neutral: 0, negative: lost.length },
        themes: [{ name: "sync", count: items.length, sentiment: "mixed", representativeQuotes: [items[0]!.text] }],
        painPoints: lost.map((item) => ({
          description: `data loss in ${item.id}`,
          severity: "critical",
          frequency: 1,
          sources: ["survey"]
        })),
        notableInsights: [],
        summary: "sync is the theme"
      }
    }
    if (asked.includes("You are a feedback routing specialist")) {
      const painPoints = JSON.parse(field(asked, "Pain points")) as ReadonlyArray<{ readonly description: string }>
      turns.push(`notify: ${painPoints.map((pain) => pain.description).join(",")}`)
      return {
        slackMessages: painPoints.map((pain) => ({
          channel: "#product-alerts",
          message: pain.description,
          priority: "urgent"
        })),
        jiraTickets: painPoints.map((pain) => ({
          project: "SYNC",
          issueType: "bug",
          title: pain.description,
          description: pain.description,
          priority: "critical",
          labels: ["feedback"]
        })),
        reportSummary: {
          title: "Weekly pulse",
          highlights: [],
          actionItems: painPoints.map((pain) => pain.description)
        },
        summary: `${painPoints.length} critical`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("drafts an urgent alert and a ticket for each critical pain point it finds", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const notification = yield* Kit.run(FeedbackPulse, {
      feedback: [{ id: "f1", text: "Sync is fast now" }, { id: "f2", text: "Sync caused data loss on my laptop" }],
      sources: ["survey"],
      dateRange: { from: "2026-10-01", to: "2026-10-07" }
    }, {
      filename: join(directory, "critical.sqlite"),
      executionId: "feedback-pulse-critical",
      script: answer,
      actions: layer
    })

    // Each step was handed what the step before it produced.
    expect(turns).toEqual([
      `intake: 2 items, sources ["survey"], range {"from":"2026-10-01","to":"2026-10-07"}`,
      "extract: f1,f2 of 2",
      "notify: data loss in f2"
    ])
    expect(notification.slackMessages).toEqual([
      { channel: "#product-alerts", message: "data loss in f2", priority: "urgent" }
    ])
    expect(notification.jiraTickets.map((ticket) => ticket.title)).toEqual(["data loss in f2"])
    expect(notification.summary).toBe("1 critical")
  }))

it.effect("hands the intake empty feedback, sources and range when none are given", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const notification = yield* Kit.run(FeedbackPulse, { feedback: [{ id: "f1", text: "Love the new sync" }] }, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "feedback-pulse-defaults",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["intake: 1 items, sources [], range {}", "extract: f1 of 1", "notify: "])
    expect(notification.slackMessages).toEqual([])
    expect(notification.jiraTickets).toEqual([])
  }))

it.effect("fails the run when the analyst fails, before anything is routed", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(FeedbackPulse, { feedback: [{ id: "f1", text: "Sync is slow" }] }, {
      filename: join(directory, "analyst-fails.sqlite"),
      executionId: "feedback-pulse-analyst-fails",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined).toMatchObject({
      _tag: "Some",
      value: { _tag: "/harness/StructuredOutputFailure" }
    })
    expect(turns).toContain("extract: f1 of 1")
    expect(turns.some((turn) => turn.startsWith("notify"))).toBe(false)
  }))
