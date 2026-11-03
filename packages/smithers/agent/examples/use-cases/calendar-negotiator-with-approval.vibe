/**
 * Propose meeting slots and draft a reply, writing the event and the email only after approval.
 *
 * Port of the 0.x `calendar-negotiator-with-approval.jsx`. A parser agent reads
 * the scheduling message; the organizer calendar, the room calendar and the
 * work-hours policy are checked side by side; an assistant agent ranks the
 * candidate slots and drafts a reply. A person then approves the write. Only on
 * approval does a writer agent create the event and then send the reply, both
 * under one idempotency key; a denial writes nothing.
 *
 * 0.x's `<Approval>` is a `HumanTask` asked for a typed decision: the run parks until a person answers it.
 * `Intervene` does not fit: it applies one change and reports it, while 0.x writes twice and has no report step.
 * 0.x's prompts ended by asking for the task's output shape; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The approval question's name, which is also the wait point a person answers. */
export const approvalName = "approve-calendar-write"

/** One candidate slot. */
export const Slot = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
  timezone: Schema.String,
  conflicts: Schema.Array(Schema.String),
  score: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

/** The parsed scheduling request. */
export const ScheduleRequest = Schema.Struct({
  title: Schema.String,
  attendees: Schema.Array(Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))),
  durationMinutes: Schema.Number,
  timeWindow: Schema.String,
  timezone: Schema.String,
  constraints: Schema.Array(Schema.String)
})

/** One availability or policy check's candidates. */
export const Availability = Schema.Struct({
  source: Schema.String,
  slots: Schema.Array(Slot),
  unavailableReasons: Schema.Array(Schema.String)
})

/** The ranked candidates. */
export const RankedSlots = Schema.Struct({
  slots: Schema.Array(Slot),
  rankingExplanation: Schema.String
})

/** The drafted reply. */
export const Reply = Schema.Struct({
  subject: Schema.String,
  body: Schema.String,
  proposedSlots: Schema.Array(Slot),
  requiresApproval: Schema.Boolean
})

/** A person's decision on the write. */
export const Approval = Schema.Struct({
  approved: Schema.Boolean,
  reviewer: Schema.String,
  note: Schema.String
})

/** What creating the event did. */
export const CalendarMutation = Schema.Struct({
  eventId: Schema.String,
  status: Schema.Literals(["created", "skipped", "failed"]),
  idempotencyKey: Schema.String,
  summary: Schema.String
})

/** What sending the reply did. */
export const EmailResult = Schema.Struct({
  messageId: Schema.String,
  status: Schema.Literals(["sent", "skipped", "failed"]),
  idempotencyKey: Schema.String
})

/** What the flow settles with. The writes are `null` when the approval was denied. */
export const Outcome = Schema.Struct({
  reply: Reply,
  approval: Approval,
  calendarMutation: Schema.NullOr(CalendarMutation),
  emailResult: Schema.NullOr(EmailResult)
})

/** The defaults the parser falls back on. */
export const Defaults = Schema.Struct({ timezone: Schema.String, durationMinutes: Schema.Number })

/** The JSON Schema the approval answer must fit; `HumanTask` checks it where the answer arrives. */
const approvalSchema = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    reviewer: { type: "string" },
    note: { type: "string" }
  },
  required: ["approved", "reviewer", "note"]
}

const calendarAgent = [
  `You are a calendar availability agent. Check free/busy data,
room calendars, and supplied availability fixtures. Return candidate slots with conflicts.`
]

const replyAgent = [
  `You are an executive assistant. Rank candidate slots and draft a
clear, polite reply that proposes the best options without committing to a write.`
]

const writerAgent = [
  `You are a calendar/email writer. Only act after approval. Use the
provided idempotency key to avoid duplicate events or duplicate replies.`
]

/** Parses the message into a request. */
export const ParseRequest = AgentAction.make("examples/CalendarNegotiator/ParseRequest", {
  payload: { message: Schema.String, defaults: Defaults },
  output: ScheduleRequest,
  seat,
  system: [
    `You are a scheduling request parser. Extract title, attendees,
duration, time window, timezone, and constraints from email or chat messages.`
  ],
  prompt: ({ defaults, message }) =>
    `Parse the scheduling message into title, attendees, duration, time window, timezone, and constraints.\n\nMessage: ${message}\nDefaults: ${
      JSON.stringify(defaults)
    }`
})

/** Checks one calendar's free/busy data. */
export const CheckAvailability = AgentAction.make("examples/CalendarNegotiator/CheckAvailability", {
  payload: { source: Schema.String, request: ScheduleRequest, calendars: Schema.Array(Schema.Json) },
  output: Availability,
  seat,
  system: calendarAgent,
  prompt: ({ calendars, request, source }) =>
    `Check availability for the requested source. Return candidate slots, conflicts, and unavailable reasons.\n\nSource: ${source}\nRequest: ${
      JSON.stringify(request)
    }\nCalendars: ${JSON.stringify(calendars)}`
})

/** Applies the scheduling policy. */
export const CheckPolicy = AgentAction.make("examples/CalendarNegotiator/CheckPolicy", {
  payload: { request: ScheduleRequest, policy: Schema.String },
  output: Availability,
  seat,
  system: [
    `You are a scheduling policy checker. Enforce work hours, buffers,
focus blocks, meeting-free days, and "never create events without approval" rules.`
  ],
  prompt: ({ policy, request }) =>
    `Apply scheduling policy to the request. Return compliant candidate slots or reasons slots are unavailable.\n\nPolicy: ${policy}\nRequest: ${
      JSON.stringify(request)
    }`
})

/** Ranks every check's candidates. */
export const RankSlots = AgentAction.make("examples/CalendarNegotiator/RankSlots", {
  payload: {
    request: ScheduleRequest,
    availability: Schema.Array(Availability),
    preferences: Schema.Array(Schema.Json)
  },
  output: RankedSlots,
  seat,
  system: replyAgent,
  prompt: ({ availability, preferences, request }) =>
    `Rank candidate slots by conflicts, policy fit, attendee convenience, and preferences. Explain the ranking.\n\nRequest: ${
      JSON.stringify(request)
    }\nPreferences: ${JSON.stringify(preferences)}\nAvailability: ${JSON.stringify(availability)}`
})

/** Drafts the reply. It writes nothing. */
export const DraftReply = AgentAction.make("examples/CalendarNegotiator/DraftReply", {
  payload: { request: ScheduleRequest, rankedSlots: RankedSlots, sender: Schema.String },
  output: Reply,
  seat,
  system: replyAgent,
  prompt: ({ rankedSlots, request, sender }) =>
    `Draft a scheduling reply that proposes slots without creating calendar state. Require approval before writes.\n\nSender: ${sender}\nRequest: ${
      JSON.stringify(request)
    }\nRanked slots: ${JSON.stringify(rankedSlots)}`
})

/** Creates the event, once, under the idempotency key. */
export const CreateEvent = AgentAction.make("examples/CalendarNegotiator/CreateEvent", {
  payload: { request: ScheduleRequest, reply: Reply, idempotencyKey: Schema.String },
  output: CalendarMutation,
  seat,
  system: writerAgent,
  prompt: ({ idempotencyKey, reply, request }) =>
    `Create or skip the calendar event using the supplied approved reply and idempotency key. Do not duplicate events.\n\nIdempotency key: ${idempotencyKey}\nRequest: ${
      JSON.stringify(request)
    }\nReply: ${JSON.stringify(reply)}`
})

/** Sends the reply, once, under the idempotency key. */
export const SendReply = AgentAction.make("examples/CalendarNegotiator/SendReply", {
  payload: { reply: Reply, threadId: Schema.String, idempotencyKey: Schema.String },
  output: EmailResult,
  seat,
  system: writerAgent,
  prompt: ({ idempotencyKey, reply, threadId }) =>
    `Send or skip the approved scheduling reply using the supplied idempotency key. Do not duplicate outbound email.\n\nIdempotency key: ${idempotencyKey}\nThread: ${threadId}\nReply: ${
      JSON.stringify(reply)
    }`
})

type Requirements = Action.Requirement<
  | "examples/CalendarNegotiator/CreateEvent"
  | "examples/CalendarNegotiator/SendReply"
>

type Failure = AgentAction.AgentFailure | HumanTask.HumanTaskFailed

/** The question a person answers before anything is written. Pure, so it is a `Node.map`. */
const question = ({ idempotencyKey, reply }: { readonly reply: typeof Reply.Type; readonly idempotencyKey: string }) =>
  `Approve calendar write\n\nDraft reply proposes ${reply.proposedSlots.length} slot(s). Calendar and email writes will use idempotency key ${idempotencyKey}.`

/**
 * Asks for approval, then writes on approval: the event first, and the reply
 * only once the event is written. `Node.andThen` holds the reply back, because
 * it does not read the event and `Node.bindPlanned` alone would let it start.
 */
const approveThenWrite = (
  request: Planned.Planned<typeof ScheduleRequest.Type>,
  reply: Planned.Planned<typeof Reply.Type>,
  threadId: string,
  idempotencyKey: string
): Node.Node<typeof Outcome.Type, Failure, Requirements> =>
  Node.bindPlanned(
    Node.map(Node.succeed({ reply, idempotencyKey }), question),
    Node.capture({ threadId, idempotencyKey: idempotencyKey ?? null }, (prompt: Planned.Planned<string>) =>
      Node.branch(
        HumanTask.decode(Approval)(
          HumanTask.action.call({ name: approvalName, kind: "json", prompt, schema: approvalSchema })
        ),
        {
          if: Node.capture({}, (approval) => approval.approved),
          then: Node.capture({ threadId, idempotencyKey: idempotencyKey ?? null }, (approval) =>
            Node.bindPlanned(
              CreateEvent.call({ request, reply, idempotencyKey }),
              Node.capture(
                { threadId, idempotencyKey: idempotencyKey ?? null },
                (calendarMutation: Planned.Planned<typeof CalendarMutation.Type>) =>
                  Node.andThen(
                    Node.succeed(calendarMutation),
                    Node.bindPlanned(
                      SendReply.call({ reply, threadId, idempotencyKey }),
                      Node.capture(
                        {},
                        (emailResult: Planned.Planned<typeof EmailResult.Type>) =>
                          Node.succeed({ reply, approval, calendarMutation, emailResult })
                      )
                    )
                  )
              )
            )),
          else: Node.capture({}, (approval) =>
            Node.succeed({ reply, approval, calendarMutation: null, emailResult: null }))
        }
      ))
  )

/** The flow: parse, check three sources, rank, draft, approve, write. */
export const CalendarNegotiator = Flow.make("examples/CalendarNegotiator", {
  payload: {
    message: Schema.optional(Schema.String),
    defaults: Schema.optional(Defaults),
    organizerCalendars: Schema.optional(Schema.Array(Schema.Json)),
    roomCalendars: Schema.optional(Schema.Array(Schema.Json)),
    policy: Schema.optional(Schema.String),
    preferences: Schema.optional(Schema.Array(Schema.Json)),
    sender: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
    idempotencyKey: Schema.optional(Schema.String)
  },
  success: Outcome,
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed]),
  body: Node.capture({}, ({
    defaults = { timezone: "America/New_York", durationMinutes: 30 },
    idempotencyKey,
    message = "Could we find 30 minutes next week, ideally Tue or Wed afternoon ET, to review the renewal?",
    organizerCalendars = [],
    policy = "No meetings before 9:30 AM; keep 15-minute buffers; require approval before writes.",
    preferences = [],
    roomCalendars = [],
    sender = "me",
    threadId = "manual"
  }) =>
    Node.bindPlanned(
      ParseRequest.call({ message, defaults }),
      Node.capture({
        idempotencyKey: idempotencyKey ?? null,
        organizerCalendars,
        policy,
        preferences,
        roomCalendars,
        sender,
        threadId
      }, (request: Planned.Planned<typeof ScheduleRequest.Type>) =>
        Node.bindPlanned(
          Node.all({
            organizer: CheckAvailability.call({ source: "organizer", request, calendars: organizerCalendars }),
            room: CheckAvailability.call({ source: "room", request, calendars: roomCalendars }),
            workHours: CheckPolicy.call({ request, policy })
          }),
          Node.capture({ idempotencyKey: idempotencyKey ?? null, preferences, sender, threadId }, (checks) =>
            Node.bindPlanned(
              RankSlots.call({ request, availability: [checks.organizer, checks.room, checks.workHours], preferences }),
              Node.capture(
                { idempotencyKey: idempotencyKey ?? null, sender, threadId },
                (rankedSlots: Planned.Planned<typeof RankedSlots.Type>) =>
                  Node.bindPlanned(
                    DraftReply.call({ request, rankedSlots, sender }),
                    Node.capture(
                      { idempotencyKey: idempotencyKey ?? null, threadId },
                      (reply: Planned.Planned<typeof Reply.Type>) =>
                        approveThenWrite(request, reply, threadId, idempotencyKey ?? `calendar-${threadId}`)
                    )
                  )
              )
            ))
        ))
    ))
})

/** The flow's action implementations; the interpreter supplies approvals. */
export const layer = Layer.mergeAll(
  ParseRequest.layer,
  CheckAvailability.layer,
  CheckPolicy.layer,
  RankSlots.layer,
  DraftReply.layer,
  CreateEvent.layer,
  SendReply.layer
)
