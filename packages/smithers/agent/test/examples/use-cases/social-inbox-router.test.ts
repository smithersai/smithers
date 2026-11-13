import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, SocialInboxRouter } from "../../../examples/use-cases/social-inbox-router.ts"

const directory = mkdtempSync(join(tmpdir(), "social-inbox-router-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

const ids = (items: ReadonlyArray<{ readonly id?: string; readonly itemId?: string }>) =>
  items.map((item) => item.id ?? item.itemId).join(",")

/**
 * A trigger that turns the first message into one inbox item, a classifier
 * that calls a demo request a lead and a bug report support (anything else is
 * noise), action agents that act on exactly the items they are handed, and a
 * summary that counts what it is handed. Each request is recorded in order;
 * the three action agents run side by side, so their order is not checked.
 */
const script = () => {
  const turns: Array<string> = []
  const prompts: Array<string> = []
  const actions: Array<string> = []
  const answer: Kit.Script = (asked) => {
    prompts.push(asked)
    if (asked.includes("Normalize this social message into an inbox item")) {
      const [message] = JSON.parse(field(asked, "Messages")) as ReadonlyArray<
        { readonly id: string; readonly from: string; readonly text: string }
      >
      turns.push(`trigger: ${field(asked, "Platform")} ${message?.id ?? "none"}`)
      return {
        id: message?.id ?? "none",
        platform: field(asked, "Platform") === "twitter" ? "twitter" : "linkedin",
        senderName: message?.from ?? "",
        messageBody: message?.text ?? "",
        receivedAt: "2026-10-14T09:00:00Z",
        summary: "one message"
      }
    }
    if (asked.includes("You are a social inbox classifier")) {
      const items = JSON.parse(field(asked, "Items")) as ReadonlyArray<
        { readonly id: string; readonly messageBody: string }
      >
      turns.push(`classify: ${ids(items)}`)
      return {
        items: items.map((item) => ({
          id: item.id,
          category: item.messageBody.includes("demo")
            ? "lead"
            : item.messageBody.includes("bug")
            ? "support"
            : item.messageBody.includes("following")
            ? "follow-up"
            : "noise",
          confidence: 0.9,
          reasoning: "keyword"
        })),
        summary: "classified"
      }
    }
    if (asked.includes("You are a sales development assistant")) {
      const leads = JSON.parse(field(asked, "Leads")) as ReadonlyArray<{ readonly id: string }>
      actions.push(`lead: [${ids(leads)}] ${field(asked, "Sender context")}`)
      return {
        actions: leads.map((lead) => ({
          itemId: lead.id,
          senderName: "Ada",
          suggestedReply: "Happy to set up a demo",
          crmAction: "create-opportunity",
          priority: "high"
        })),
        summary: `${leads.length} leads`
      }
    }
    if (asked.includes("You are a support triage specialist")) {
      const items = JSON.parse(field(asked, "Support items")) as ReadonlyArray<{ readonly id: string }>
      actions.push(`support: [${ids(items)}]`)
      return {
        tickets: items.map((item) => ({
          itemId: item.id,
          subject: "Bug report",
          urgency: "high",
          suggestedReply: "We are on it",
          escalate: false
        })),
        summary: `${items.length} tickets`
      }
    }
    if (asked.includes("You are a relationship manager")) {
      const followUps = JSON.parse(field(asked, "Follow-ups")) as ReadonlyArray<{ readonly id: string }>
      actions.push(`follow-up: [${ids(followUps)}]`)
      return { followUps: [], summary: `${followUps.length} follow-ups` }
    }
    if (asked.includes("Summarize the routing results")) {
      const classified = JSON.parse(field(asked, "Classified")) as {
        readonly items: ReadonlyArray<{ readonly category: string }>
      }
      const lead = JSON.parse(field(asked, "Lead actions")) as {
        readonly actions: ReadonlyArray<{ readonly itemId: string }>
      }
      const support = JSON.parse(field(asked, "Support actions")) as {
        readonly tickets: ReadonlyArray<{ readonly itemId: string }>
      }
      turns.push("summary")
      const count = (category: string) => classified.items.filter((item) => item.category === category).length
      return {
        totalProcessed: classified.items.length,
        categoryCounts: {
          lead: count("lead"),
          noise: count("noise"),
          support: count("support"),
          followUp: count("follow-up")
        },
        leadActions: lead.actions.map((action) => action.itemId),
        supportTickets: support.tickets.map((ticket) => ticket.itemId),
        followUps: [],
        summary: "routed"
      }
    }
    return undefined
  }
  return { actions, answer, prompts, turns }
}

it.effect("opens a ticket for a support message and still asks every action agent", () =>
  Effect.gen(function*() {
    const { actions, answer, turns } = script()
    const output = yield* Kit.run(SocialInboxRouter, {
      messages: [{ id: "m1", from: "Ada", text: "Found a bug in the export" }]
    }, {
      filename: join(directory, "support.sqlite"),
      executionId: "social-inbox-router-support",
      script: answer,
      actions: layer
    })

    // The platform defaults to LinkedIn; the classifier saw the one normalized item.
    expect(turns).toEqual(["trigger: linkedin m1", "classify: m1", "summary"])
    // All three action agents ran, as in 0.x; only support was handed the item.
    expect([...actions].sort()).toEqual(["follow-up: []", "lead: [] {}", "support: [m1]"])
    expect(output).toEqual({
      totalProcessed: 1,
      categoryCounts: { lead: 0, noise: 0, support: 1, followUp: 0 },
      leadActions: [],
      supportTickets: ["m1"],
      followUps: [],
      summary: "routed"
    })
  }))

it.effect("hands a lead to the lead agent with the sender context", () =>
  Effect.gen(function*() {
    const { actions, answer, turns } = script()
    const output = yield* Kit.run(SocialInboxRouter, {
      messages: [{ id: "t7", from: "Grace", text: "Could we get a demo for my team?" }],
      platform: "twitter",
      senderContext: { tier: "enterprise" }
    }, {
      filename: join(directory, "lead.sqlite"),
      executionId: "social-inbox-router-lead",
      script: answer,
      actions: layer
    })

    expect(turns[0]).toBe("trigger: twitter t7")
    expect([...actions].sort()).toEqual(["follow-up: []", `lead: [t7] {"tier":"enterprise"}`, "support: []"])
    expect(output.categoryCounts).toEqual({ lead: 1, noise: 0, support: 0, followUp: 0 })
    expect(output.leadActions).toEqual(["t7"])
  }))

it.effect("hands every action agent an empty list for noise", () =>
  Effect.gen(function*() {
    const { actions, answer } = script()
    const output = yield* Kit.run(SocialInboxRouter, { messages: [{ id: "n1", from: "Bot", text: "Congrats!" }] }, {
      filename: join(directory, "noise.sqlite"),
      executionId: "social-inbox-router-noise",
      script: answer,
      actions: layer
    })

    expect([...actions].sort()).toEqual(["follow-up: []", "lead: [] {}", "support: []"])
    expect(output.categoryCounts).toEqual({ lead: 0, noise: 1, support: 0, followUp: 0 })
    expect(output.leadActions).toEqual([])
    expect(output.supportTickets).toEqual([])
  }))

for (
  const [text, role] of [
    ["Could we get a demo?", "You are a sales development assistant"],
    ["Found a bug in export", "You are a support triage specialist"],
    ["following up on our quote", "You are a relationship manager"]
  ] as const
) {
  it.effect(`passes the sender and message to ${role}`, () =>
    Effect.gen(function*() {
      const { answer, prompts } = script()
      yield* Kit.run(SocialInboxRouter, { messages: [{ id: "source", from: "Grace", text }] }, {
        filename: join(directory, `content-${text.length}.sqlite`),
        executionId: `social-content-${text.length}`,
        script: answer,
        actions: layer
      })
      const prompt = prompts.find((asked) => asked.includes(role))
      expect(prompt).toContain("Grace")
      expect(prompt).toContain(text)
    }))
}
