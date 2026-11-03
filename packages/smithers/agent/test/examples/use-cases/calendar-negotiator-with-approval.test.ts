import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { type DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import type * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CalendarNegotiator, layer } from "../../../examples/use-cases/calendar-negotiator-with-approval.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "calendar-negotiator-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A person who waits until the run parks on an approval, records the question
 * it published, and answers with `decision`. It runs beside the run, on the
 * same engine, and answers through `HumanTask.answer` with the token the park
 * declared, as an approvals inbox would.
 */
const reviewer = (executionId: string, decision: typeof Schema.Json.Type, questions: Array<string>) =>
  Layer.effectDiscard(Effect.forkScoped(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* state.waiting(executionId).pipe(
        Effect.repeat({
          until: (row) => Option.isSome(row) && row.value.reason === "approval",
          schedule: Schedule.spaced(10)
        })
      )
      const parked = Option.getOrThrow(row)
      const request = typeof parked.request === "string" ? JSON.parse(parked.request) : parked.request
      questions.push(`${request.name}: ${request.prompt}`)
      // The waiting row stores the token as plain text; it is the token the park declared.
      yield* HumanTask.answer({ token: parked.token as DurableDeferred.Token, value: decision })
    }).pipe(Effect.orDie)
  ))

const slot = (start: string, score: number) => ({
  start,
  end: start.replace("15:00:00", "15:30:00"),
  timezone: "America/New_York",
  conflicts: [],
  score
})

/**
 * Agents that answer from what they are handed: the parser reads the thread's
 * attendee from the message, each calendar check offers one slot named after
 * its source, the ranker keeps the slots it was handed best first, the drafter
 * proposes the top two, and the writers echo the idempotency key. Each request
 * is recorded in order. `brokenWriter` makes the event writer answer off-schema.
 */
const script = (brokenWriter = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const parse = /\n\nMessage: (.+)\nDefaults: (.+)/.exec(asked)
    if (parse !== null) {
      const defaults = JSON.parse(parse[2]!)
      turns.push(`parse: ${parse[1]}`)
      return {
        title: "Renewal review",
        attendees: ["dana@acme.example"],
        durationMinutes: defaults.durationMinutes,
        timeWindow: "next Tue-Wed afternoon",
        timezone: defaults.timezone,
        constraints: ["afternoon"]
      }
    }
    const check = /\n\nSource: (\w+)\nRequest: .+\nCalendars: (.+)/.exec(asked)
    if (check !== null) {
      turns.push(`check ${check[1]}`)
      return {
        source: check[1],
        slots: [slot(check[1] === "organizer" ? "2026-10-20T15:00:00" : "2026-10-21T15:00:00", 0.6)],
        unavailableReasons: []
      }
    }
    const policy = /\n\nPolicy: (.+)\nRequest: /.exec(asked)
    if (policy !== null) {
      turns.push(`policy: ${policy[1]}`)
      return { source: "work-hours", slots: [slot("2026-10-21T15:00:00", 0.9)], unavailableReasons: [] }
    }
    const rank = /\nAvailability: (.+)/.exec(asked)
    if (rank !== null && asked.includes("Rank candidate slots")) {
      const availability: ReadonlyArray<{ source: string; slots: ReadonlyArray<ReturnType<typeof slot>> }> = JSON.parse(
        rank[1]!
      )
      turns.push(`rank ${availability.map((a) => a.source).join(", ")}`)
      return {
        slots: availability.flatMap((a) => a.slots).sort((a, b) => b.score - a.score),
        rankingExplanation: "work-hours fit first"
      }
    }
    const draft = /\n\nSender: (.+)\nRequest: .+\nRanked slots: (.+)/.exec(asked)
    if (draft !== null) {
      const ranked: { slots: ReadonlyArray<ReturnType<typeof slot>> } = JSON.parse(draft[2]!)
      turns.push(`draft from ${draft[1]}`)
      return {
        subject: "Renewal review",
        body: `Would ${ranked.slots[0]!.start} work?`,
        proposedSlots: ranked.slots.slice(0, 2),
        requiresApproval: true
      }
    }
    const write = /\n\nIdempotency key: (.+)\n/.exec(asked)
    if (write !== null && asked.includes("Create or skip the calendar event")) {
      turns.push(`create event ${write[1]}`)
      if (brokenWriter) return { unexpected: true }
      return { eventId: "evt-1", status: "created", idempotencyKey: write[1], summary: "Renewal review booked" }
    }
    if (write !== null && asked.includes("Send or skip the approved scheduling reply")) {
      turns.push(`send reply ${write[1]} on ${/\nThread: (.+)/.exec(asked)?.[1]}`)
      return { messageId: "msg-1", status: "sent", idempotencyKey: write[1] }
    }
    return undefined
  }
  return { answer, turns }
}

// `it.live`: the reviewer polls the engine's waiting row on a schedule, and a
// test clock nobody advances would leave that poll asleep forever.
it.live("writes the event and then the reply once the write is approved", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const questions: Array<string> = []
    const executionId = "calendar-approved"
    const outcome = yield* Kit.run(CalendarNegotiator, { threadId: "thread-42" }, {
      filename: join(directory, "approved.sqlite"),
      executionId,
      script: answer,
      actions: Layer.mergeAll(
        layer,
        reviewer(executionId, { approved: true, reviewer: "ops@acme.example", note: "ok" }, questions)
      )
    })

    // Parse first; the three checks in any order; then rank, draft, and the writes in order.
    expect(turns[0]).toBe(
      "parse: Could we find 30 minutes next week, ideally Tue or Wed afternoon ET, to review the renewal?"
    )
    expect([...turns.slice(1, 4)].sort()).toEqual([
      "check organizer",
      "check room",
      "policy: No meetings before 9:30 AM; keep 15-minute buffers; require approval before writes."
    ])
    expect(turns.slice(4)).toEqual([
      "rank organizer, room, work-hours",
      "draft from me",
      "create event calendar-thread-42",
      "send reply calendar-thread-42 on thread-42"
    ])
    // The person was asked about the draft the flow produced, under the key the writes used.
    expect(questions).toEqual([
      "approve-calendar-write: Approve calendar write\n\nDraft reply proposes 2 slot(s). Calendar and email writes will use idempotency key calendar-thread-42."
    ])
    expect(outcome.reply.proposedSlots.map((s) => s.start)).toEqual(["2026-10-21T15:00:00", "2026-10-20T15:00:00"])
    expect(outcome.approval).toEqual({ approved: true, reviewer: "ops@acme.example", note: "ok" })
    expect(outcome.calendarMutation?.idempotencyKey).toBe("calendar-thread-42")
    expect(outcome.emailResult).toEqual({ messageId: "msg-1", status: "sent", idempotencyKey: "calendar-thread-42" })
  }), { timeout: 60_000 })

it.live("writes nothing when the write is denied", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const questions: Array<string> = []
    const executionId = "calendar-denied"
    const outcome = yield* Kit.run(CalendarNegotiator, { idempotencyKey: "renewal-7" }, {
      filename: join(directory, "denied.sqlite"),
      executionId,
      script: answer,
      actions: Layer.mergeAll(
        layer,
        reviewer(executionId, { approved: false, reviewer: "ops@acme.example", note: "not this week" }, questions)
      )
    })

    expect(questions).toHaveLength(1)
    expect(questions[0]).toContain("will use idempotency key renewal-7.")
    expect(turns.some((turn) => turn.startsWith("create event") || turn.startsWith("send reply"))).toBe(false)
    expect(outcome.approval.approved).toBe(false)
    expect(outcome.calendarMutation).toBeNull()
    expect(outcome.emailResult).toBeNull()
  }), { timeout: 60_000 })

it.live("sends no reply when the calendar write fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const executionId = "calendar-write-failed"
    const exit = yield* Effect.exit(Kit.run(CalendarNegotiator, {}, {
      filename: join(directory, "write-failed.sqlite"),
      executionId,
      script: answer,
      actions: Layer.mergeAll(layer, reviewer(executionId, { approved: true, reviewer: "ops", note: "" }, []))
    }))

    // The event writer was asked (and re-asked for a correction), the run
    // failed, and the reply, which waits for the event, was never sent.
    expect(turns).toContain("create event calendar-manual")
    expect(turns.some((turn) => turn.startsWith("send reply"))).toBe(false)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("StructuredOutputFailure")
  }), { timeout: 60_000 })
