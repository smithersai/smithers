import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, RevenueScout } from "../../../examples/use-cases/revenue-scout.vibe"

const directory = mkdtempSync(join(tmpdir(), "revenue-scout-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

interface Thread {
  readonly id: string
  readonly text: string
}

/**
 * A classifier that flags every conversation mentioning seats as expansion, an
 * extractor that turns each flagged conversation it is handed into one
 * opportunity, and a handoff agent that counts what it is handed. Every
 * request is recorded in order with the ids or counts it carried.
 */
const script = () => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a revenue signal classifier")) {
      const threads = JSON.parse(field(asked, "Conversations")) as ReadonlyArray<Thread>
      turns.push(`classify: ${field(asked, "Source")} ${threads.map((thread) => thread.id).join(",")}`)
      return {
        conversations: threads.map((thread) => {
          const signal = thread.text.includes("seats")
          return {
            id: thread.id,
            source: "support",
            hasSignal: signal,
            signalType: signal ? "expansion" : "none",
            confidence: signal ? 0.9 : 0.1,
            reasoning: signal ? "asks for more seats" : "routine question"
          }
        })
      }
    }
    if (asked.includes("You are a sales intelligence extractor")) {
      const flagged = JSON.parse(field(asked, "Flagged conversations")) as ReadonlyArray<{ readonly id: string }>
      turns.push(`extract: ${flagged.map((conversation) => conversation.id).join(",")}`)
      return {
        opportunities: flagged.map((conversation) => ({
          conversationId: conversation.id,
          signalType: "expansion",
          product: "Enterprise",
          customerName: `customer of ${conversation.id}`,
          keyQuotes: ["we need 40 more seats"],
          urgency: "near-term",
          summary: "seat expansion"
        }))
      }
    }
    if (asked.includes("You are a CRM handoff coordinator")) {
      const opportunities = JSON.parse(field(asked, "Opportunities")) as ReadonlyArray<
        { readonly conversationId: string; readonly signalType: string }
      >
      const totalScanned = Number(field(asked, "Total scanned"))
      turns.push(`handoff: ${opportunities.length} of ${totalScanned} to ${field(asked, "CRM target")}`)
      const bySignalType: Record<string, number> = {}
      for (const opportunity of opportunities) {
        bySignalType[opportunity.signalType] = (bySignalType[opportunity.signalType] ?? 0) + 1
      }
      return {
        totalScanned,
        opportunitiesFound: opportunities.length,
        routedToCrm: opportunities.length,
        bySignalType,
        handoffs: opportunities.map((opportunity) => ({
          conversationId: opportunity.conversationId,
          assignedRep: "Ada",
          priority: "warm",
          nextStep: "call about seats"
        })),
        summary: `${opportunities.length} of ${totalScanned} routed`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("extracts only the flagged conversations and hands them to sales", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const handoff = yield* Kit.run(RevenueScout, {
      conversations: [
        { id: "c1", text: "Can we add 40 seats next quarter?" },
        { id: "c2", text: "How do I reset my password?" },
        { id: "c3", text: "Pricing for 10 more seats?" }
      ],
      crmTarget: "hubspot"
    }, {
      filename: join(directory, "flagged.sqlite"),
      executionId: "revenue-scout-flagged",
      script: answer,
      actions: layer
    })

    // The extractor saw only the two flagged conversations; the handoff was
    // told their opportunities and the full scan count.
    expect(turns).toEqual(["classify: support c1,c2,c3", "extract: c1,c3", "handoff: 2 of 3 to hubspot"])
    expect(handoff).toEqual({
      totalScanned: 3,
      opportunitiesFound: 2,
      routedToCrm: 2,
      bySignalType: { expansion: 2 },
      handoffs: [
        { conversationId: "c1", assignedRep: "Ada", priority: "warm", nextStep: "call about seats" },
        { conversationId: "c3", assignedRep: "Ada", priority: "warm", nextStep: "call about seats" }
      ],
      summary: "2 of 3 routed"
    })
  }))

it.effect("skips extraction and hands off nothing when no conversation carries a signal", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const handoff = yield* Kit.run(RevenueScout, {
      source: "email",
      conversations: [{ id: "e1", text: "Thanks for the quick fix" }]
    }, {
      filename: join(directory, "no-signal.sqlite"),
      executionId: "revenue-scout-no-signal",
      script: answer,
      actions: layer
    })

    // No extractor request at all, and the handoff defaults to Salesforce.
    expect(turns).toEqual(["classify: email e1", "handoff: 0 of 1 to salesforce"])
    expect(handoff.opportunitiesFound).toBe(0)
    expect(handoff.handoffs).toEqual([])
  }))
