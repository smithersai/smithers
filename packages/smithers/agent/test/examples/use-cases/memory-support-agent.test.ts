import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, MemorySupportAgent } from "../../../examples/use-cases/memory-support-agent.vibe"

const directory = mkdtempSync(join(tmpdir(), "memory-support-agent-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const line = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

/**
 * Agents whose answers are derived from the prompt each was handed: recall
 * keys its one fact by the customer it was asked about, the support agent
 * replies with the facts it was given at `confidence`, persistence records the
 * reply it was given, and escalation quotes the score it was given. Every
 * request is recorded in order as `step: detail`.
 */
const script = (confidence: number) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a memory retrieval specialist")) {
      const customer = line(asked, "Customer")
      turns.push(`recall: ${customer} ${line(asked, "Conversation history")}`)
      return {
        customerId: customer,
        facts: [{ key: "plan", value: `${customer} is on the team plan`, updatedAt: "2026-10-01" }],
        recentTickets: [`${customer}-T1`],
        sentiment: "frustrated"
      }
    }
    if (asked.includes("You are a senior support agent")) {
      const facts = JSON.parse(line(asked, "Facts")) as ReadonlyArray<{ readonly value: string }>
      turns.push(`respond: ${line(asked, "Sentiment")} ${line(asked, "Latest message")}`)
      return {
        reply: `Since ${facts.map((fact) => fact.value).join(", ")}, seats are added in Settings.`,
        confidenceScore: confidence,
        needsEscalation: confidence < 50,
        reasoning: confidence < 50 ? "billing data not in memory" : "answered from memory",
        suggestedActions: ["open billing"]
      }
    }
    if (asked.includes("You are a memory persistence agent")) {
      const reply = line(asked, "Reply")
      turns.push(`persist: ${reply}`)
      return {
        customerId: line(asked, "Customer"),
        newFacts: [{ key: "last-reply", value: reply, updatedAt: "2026-10-14" }],
        removedKeys: [],
        summary: "recorded the reply"
      }
    }
    if (asked.includes("You are an escalation router")) {
      turns.push(
        `escalate: ${line(asked, "Confidence score")} ${line(asked, "Sentiment")} ${line(asked, "Recent tickets")}`
      )
      return {
        escalated: true,
        tier: "t2",
        reason: line(asked, "Reasoning"),
        context: `score ${line(asked, "Confidence score")}`,
        summary: "sent to billing"
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("replies from recalled memory, persists the reply, and escalates nothing when confident", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(90)
    const output = yield* Kit.run(MemorySupportAgent, {
      customerId: "acme-42",
      conversationHistory: [{ from: "customer", text: "hi" }],
      latestMessage: "How do I add seats?"
    }, {
      filename: join(directory, "confident.sqlite"),
      executionId: "memory-support-confident",
      script: answer,
      actions: layer
    })

    // Each step read the one before it: the reply quotes the recalled fact,
    // and persistence was handed that reply.
    expect(turns).toEqual([
      "recall: acme-42 [{\"from\":\"customer\",\"text\":\"hi\"}]",
      "respond: frustrated How do I add seats?",
      "persist: Since acme-42 is on the team plan, seats are added in Settings."
    ])
    expect(output.escalation).toBeNull()
    expect(output.persist.newFacts[0]?.value).toBe(output.response.reply)
    expect(output.recall.customerId).toBe("acme-42")
  }))

it.effect("escalates a low-confidence reply after persisting it", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(30)
    const output = yield* Kit.run(MemorySupportAgent, {}, {
      filename: join(directory, "escalated.sqlite"),
      executionId: "memory-support-escalated",
      script: answer,
      actions: layer
    })

    // With no payload, the customer is "unknown" with no history and an empty message.
    expect(turns).toEqual([
      "recall: unknown []",
      "respond: frustrated ",
      "persist: Since unknown is on the team plan, seats are added in Settings.",
      "escalate: 30 frustrated [\"unknown-T1\"]"
    ])
    expect(output.escalation).toEqual({
      escalated: true,
      tier: "t2",
      reason: "billing data not in memory",
      context: "score 30",
      summary: "sent to billing"
    })
  }))

it.effect("fails the run when an agent answers off-schema", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(90)
    const broken: Kit.Script = (asked) =>
      asked.includes("You are a senior support agent") ? { reply: "no score" } : answer(asked)
    const exit = yield* Effect.exit(Kit.run(MemorySupportAgent, { customerId: "acme-42" }, {
      filename: join(directory, "broken.sqlite"),
      executionId: "memory-support-broken",
      script: broken,
      actions: layer
    }))

    // Nothing downstream of the failed reply ran.
    expect(exit._tag).toBe("Failure")
    expect(turns).toEqual(["recall: acme-42 []"])
  }))
