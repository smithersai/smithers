import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, MeetingBriefer } from "../../../examples/use-cases/meeting-briefer.vibe"

const directory = mkdtempSync(join(tmpdir(), "meeting-briefer-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const event = {
  meetingId: "mtg-17",
  title: "Acme renewal",
  organizer: "sam@vendor.example",
  attendees: ["dana@acme.example", "lee@acme.example"],
  scheduledAt: "2026-10-20T15:00:00Z",
  calendarSource: "google" as const,
  summary: "Renewal call with Acme"
}

/**
 * Agents that answer from the input they are handed: the classifier calls a
 * title with "renewal" in it a high-priority renewal, the CRM agent echoes the
 * account it was asked about, the attendee agent makes the first attendee the
 * champion, the history agent recalls one meeting, and the briefer assembles
 * the brief from what it was handed. `brokenClassifier` makes the classifier
 * answer off-schema. Each request is recorded in order.
 */
const script = (brokenClassifier = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const input = /\n\nInput: (.+)/.exec(asked)
    if (input === null) return undefined
    const given = JSON.parse(input[1]!)
    if (asked.includes("Classify this meeting.")) {
      turns.push(`classify ${given.title} (${given.calendarSource}) description "${given.description}"`)
      if (brokenClassifier) return { unexpected: true }
      const renewal = /renewal/i.test(given.title)
      return {
        intent: renewal ? "renewal" : "other",
        priority: renewal ? "high" : "low",
        flags: renewal ? ["at-risk renewal"] : [],
        summary: given.title
      }
    }
    if (asked.includes("Gather the CRM context")) {
      turns.push(`crm ${given.accountName} for ${given.intent}`)
      return {
        accountId: "acct-1",
        accountName: given.accountName,
        ownerName: "Sam",
        openTickets: 2,
        notes: [],
        summary: `${given.accountName} has 2 open tickets`
      }
    }
    if (asked.includes("Research the attendees")) {
      turns.push(`attendees ${given.attendees.length}`)
      return {
        profiles: given.attendees.map((email: string, i: number) => ({
          name: email.split("@")[0],
          title: "VP",
          role: i === 0 ? "champion" : "unknown"
        })),
        summary: ""
      }
    }
    if (asked.includes("Gather the history")) {
      turns.push(`history ${given.meetingTitle} for ${given.accountName}`)
      return {
        previousMeetings: [{ date: "2026-07-01", topic: "QBR", outcome: "pricing concerns" }],
        openActionItems: ["send revised quote"],
        summary: ""
      }
    }
    if (asked.includes("Write the prep brief")) {
      turns.push("brief")
      return {
        meetingId: given.meetingId,
        headline: `${given.priority} ${given.intent}: ${given.title}`,
        intent: given.intent,
        priority: given.priority,
        accountSnapshot: given.crmContext.summary,
        attendeeSummary: given.attendeeProfiles.map((p: { name: string; role: string }) => `${p.name} (${p.role})`)
          .join(
            ", "
          ),
        talkingPoints: given.previousMeetings.map((m: { outcome: string }) => `Follow up on ${m.outcome}`),
        risksAndFlags: given.flags,
        suggestedAgenda: ["Recap", "Pricing", "Next steps"],
        openItems: given.openActionItems,
        summary: `Brief for ${given.scheduledAt}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("classifies the meeting, gathers three contexts, and briefs from all of them", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const brief = yield* Kit.run(MeetingBriefer, { event }, {
      filename: join(directory, "brief.sqlite"),
      executionId: "meeting-briefer-brief",
      script: answer,
      actions: layer
    })

    // Classification first, the three contexts in any order, the brief last.
    // As in 0.x, the CRM and history steps are asked about the meeting title.
    expect(turns[0]).toBe("classify Acme renewal (google) description \"\"")
    expect([...turns.slice(1, 4)].sort()).toEqual([
      "attendees 2",
      "crm Acme renewal for renewal",
      "history Acme renewal for Acme renewal"
    ])
    expect(turns[4]).toBe("brief")
    expect(brief).toEqual({
      meetingId: "mtg-17",
      headline: "high renewal: Acme renewal",
      intent: "renewal",
      priority: "high",
      accountSnapshot: "Acme renewal has 2 open tickets",
      attendeeSummary: "dana (champion), lee (unknown)",
      talkingPoints: ["Follow up on pricing concerns"],
      risksAndFlags: ["at-risk renewal"],
      suggestedAgenda: ["Recap", "Pricing", "Next steps"],
      openItems: ["send revised quote"],
      summary: "Brief for 2026-10-20T15:00:00Z"
    })
  }))

it.effect("gathers no context when the classification fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(MeetingBriefer, { event: { ...event, description: "Q4 renewal" } }, {
      filename: join(directory, "unclassified.sqlite"),
      executionId: "meeting-briefer-unclassified",
      script: answer,
      actions: layer
    }))

    // The classifier was asked (and re-asked for a correction) with the
    // description, the run failed, and no context step started beside it.
    expect(turns).toContain("classify Acme renewal (google) description \"Q4 renewal\"")
    expect(turns.every((turn) => turn.startsWith("classify"))).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
  }))
