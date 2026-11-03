import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, SupportDeflector } from "../../../examples/use-cases/support-deflector.vibe"

const directory = mkdtempSync(join(tmpdir(), "support-deflector-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

interface Scenario {
  readonly category: string
  readonly riskLevel: "low" | "medium" | "high"
  readonly coverageScore: number
  readonly confidenceInDraft: number
}

/**
 * Four agents that answer from `scenario` and from what they are handed: the
 * retriever finds one article per word of the category it was told, and the
 * drafter's tone follows the sentiment it was told. Every request is recorded
 * in order with the value that carried the handoff.
 */
const script = (scenario: Scenario) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a support ticket classifier")) {
      turns.push(`classify: ${field(asked, "Subject")} from ${field(asked, "Customer")}`)
      return {
        category: scenario.category,
        sentiment: scenario.riskLevel === "high" ? "angry" : "neutral",
        confidence: 95,
        riskLevel: scenario.riskLevel,
        escalate: false,
        reasoning: `${scenario.category} question`
      }
    }
    if (asked.includes("You are a knowledge-base retrieval specialist")) {
      const category = field(asked, "Category")
      turns.push(`retrieve: ${category}`)
      return {
        articles: category.split("-").map((word) => ({
          title: `About ${word}`,
          relevance: 80,
          snippet: "...",
          source: "kb"
        })),
        coverageScore: scenario.coverageScore
      }
    }
    if (asked.includes("You are a support response drafter")) {
      const articles = JSON.parse(field(asked, "Articles")) as ReadonlyArray<{ readonly title: string }>
      const sentiment = field(asked, "Sentiment")
      turns.push(`draft: ${sentiment} ${articles.map((article) => article.title).join(",")}`)
      return {
        subject: "Re: your ticket",
        body: "Here is how",
        tone: sentiment === "angry" ? "empathetic" : "professional",
        suggestedActions: [],
        confidenceInDraft: scenario.confidenceInDraft
      }
    }
    if (asked.includes("You are an escalation specialist")) {
      const ticket = JSON.parse(field(asked, "Ticket")) as {
        readonly ticketId: string
        readonly draftConfidence: number
        readonly coverageScore: number
      }
      turns.push(`escalate: ${ticket.ticketId} draft ${ticket.draftConfidence} coverage ${ticket.coverageScore}`)
      return { reason: "risky", priority: "urgent", assignTo: "tier-2", context: "see ticket" }
    }
    return undefined
  }
  return { answer, turns }
}

const routine: Scenario = { category: "how-to", riskLevel: "low", coverageScore: 90, confidenceInDraft: 90 }

it.effect("deflects a routine ticket with the drafted reply and asks no escalation", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(routine)
    const outcome = yield* Kit.run(SupportDeflector, {
      ticket: { id: "t1", subject: "How do I export?", body: "Where is export?", customer: "acme" }
    }, {
      filename: join(directory, "deflected.sqlite"),
      executionId: "support-deflector-deflected",
      script: answer,
      actions: layer
    })

    // The retriever was told the classifier's category and the drafter the retriever's articles.
    expect(turns).toEqual([
      "classify: How do I export? from acme",
      "retrieve: how-to",
      "draft: neutral About how,About to"
    ])
    expect(outcome).toEqual({
      status: "deflected",
      ticketId: "t1",
      summary: "Auto-replied with professional response covering 2 knowledge articles"
    })
  }))

it.effect("escalates a high-risk ticket to a person after the draft", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ ...routine, category: "outage", riskLevel: "high" })
    const outcome = yield* Kit.run(SupportDeflector, { ticket: { id: "t2", subject: "Everything is down" } }, {
      filename: join(directory, "escalated.sqlite"),
      executionId: "support-deflector-escalated",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "classify: Everything is down from unknown",
      "retrieve: outage",
      "draft: angry About outage",
      "escalate: t2 draft 90 coverage 90"
    ])
    expect(outcome).toEqual({
      status: "escalated",
      ticketId: "t2",
      summary: "Ticket escalated to human agent — high risk, outage category"
    })
  }))

it.effect("escalates on draft confidence under 50 and coverage under 40, and deflects at the bounds", () =>
  Effect.gen(function*() {
    const settle = (scenario: Scenario, name: string) =>
      Kit.run(SupportDeflector, {}, {
        filename: join(directory, `${name}.sqlite`),
        executionId: `support-deflector-${name}`,
        script: script(scenario).answer,
        actions: layer
      })

    const unsureDraft = yield* settle({ ...routine, confidenceInDraft: 49 }, "draft-49")
    const sureDraft = yield* settle({ ...routine, confidenceInDraft: 50 }, "draft-50")
    const thinCoverage = yield* settle({ ...routine, coverageScore: 39 }, "coverage-39")
    const enoughCoverage = yield* settle({ ...routine, coverageScore: 40 }, "coverage-40")

    expect([unsureDraft.status, sureDraft.status, thinCoverage.status, enoughCoverage.status]).toEqual([
      "escalated",
      "deflected",
      "escalated",
      "deflected"
    ])
    // With no ticket given, the outcome names the ticket "unknown".
    expect(unsureDraft.ticketId).toBe("unknown")
  }))
