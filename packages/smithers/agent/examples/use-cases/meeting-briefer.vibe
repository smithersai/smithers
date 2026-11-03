/**
 * Classify a scheduled meeting, gather its account, attendee and history context, and write a prep brief.
 *
 * Port of the 0.x `meeting-briefer.jsx`. A calendar or booking trigger hands
 * the flow one meeting event. A classifier agent reads its intent, priority and
 * flags; then three agents gather context side by side: the CRM account, the
 * attendees' roles, and past meetings with their open action items. A briefing
 * agent writes the brief from all of it. Any failed step fails the run.
 *
 * 0.x's `trigger` and `history-context` tasks had no agent, so each settled with its unrendered prompt and failed its schema; here the trigger's event is the payload, and an agent gathers the history.
 * 0.x's history step read the CRM account name, but it ran beside the CRM step and started with the meeting title; here it is handed the title, as 0.x's CRM step was.
 * 0.x's prompts were placeholders that printed their props; these prompts state the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The meeting the trigger fired for. */
export const MeetingEvent = Schema.Struct({
  meetingId: Schema.String,
  title: Schema.String,
  organizer: Schema.String,
  attendees: Schema.Array(Schema.String),
  scheduledAt: Schema.String,
  calendarSource: Schema.Literals(["google", "outlook", "calendly", "hubspot", "other"]),
  description: Schema.optional(Schema.String),
  summary: Schema.String
})

/** What the meeting is for, and how much it matters. */
export const Classification = Schema.Struct({
  intent: Schema.Literals([
    "discovery",
    "demo",
    "renewal",
    "upsell",
    "support-escalation",
    "internal-sync",
    "partnership",
    "other"
  ]),
  priority: Schema.Literals(["low", "medium", "high", "critical"]),
  accountTier: Schema.optional(Schema.Literals(["free", "starter", "growth", "enterprise"])),
  flags: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The account's CRM record. */
export const CrmContext = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  opportunityStage: Schema.optional(Schema.String),
  arr: Schema.optional(Schema.Number),
  ownerName: Schema.String,
  openTickets: Schema.Number,
  lastTouchDate: Schema.optional(Schema.String),
  notes: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Who is coming, and their role in the deal. */
export const AttendeeContext = Schema.Struct({
  profiles: Schema.Array(Schema.Struct({
    name: Schema.String,
    title: Schema.String,
    role: Schema.Literals(["champion", "decision-maker", "influencer", "end-user", "unknown"]),
    linkedinUrl: Schema.optional(Schema.String),
    recentActivity: Schema.optional(Schema.String)
  })),
  summary: Schema.String
})

/** Past meetings and what is still open from them. */
export const HistoryContext = Schema.Struct({
  previousMeetings: Schema.Array(Schema.Struct({ date: Schema.String, topic: Schema.String, outcome: Schema.String })),
  openActionItems: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The prep brief the flow settles with. */
export const Brief = Schema.Struct({
  meetingId: Schema.String,
  headline: Schema.String,
  intent: Schema.String,
  priority: Schema.String,
  accountSnapshot: Schema.String,
  attendeeSummary: Schema.String,
  talkingPoints: Schema.Array(Schema.String),
  risksAndFlags: Schema.Array(Schema.String),
  suggestedAgenda: Schema.Array(Schema.String),
  openItems: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Reads the meeting's intent, priority and flags. */
export const Classify = AgentAction.make("examples/MeetingBriefer/Classify", {
  payload: {
    title: Schema.String,
    description: Schema.String,
    organizer: Schema.String,
    attendees: Schema.Array(Schema.String),
    calendarSource: Schema.String
  },
  output: Classification,
  seat,
  system: [
    `You are a meeting intent classifier. Given a calendar event with its title,
description, attendees, and source, determine the meeting intent, priority level, account tier,
and any flags (e.g. at-risk renewal, executive attendee, competitor mentioned). Be precise
and use all available signals.`
  ],
  prompt: (input) => `Classify this meeting.\n\nInput: ${JSON.stringify(input)}`
})

/** Pulls the account's CRM record. */
export const GatherCrm = AgentAction.make("examples/MeetingBriefer/CrmContext", {
  payload: { accountName: Schema.String, attendees: Schema.Array(Schema.String), intent: Schema.String },
  output: CrmContext,
  seat,
  system: [
    `You are a CRM context gatherer. Given an account name and attendees,
pull the relevant account record, opportunity stage, ARR, owner, open support tickets,
last touch date, and recent CRM notes. Summarize the account health concisely.`
  ],
  prompt: (input) => `Gather the CRM context for this meeting.\n\nInput: ${JSON.stringify(input)}`
})

/** Researches each attendee. */
export const GatherAttendees = AgentAction.make("examples/MeetingBriefer/AttendeeContext", {
  payload: { attendees: Schema.Array(Schema.String), organizer: Schema.String },
  output: AttendeeContext,
  seat,
  system: [
    `You are an attendee research specialist. Given a list of meeting attendees,
look up each person's title, role in the buying process, LinkedIn profile, and any recent
activity or engagement signals. Classify each attendee's influence level.`
  ],
  prompt: (input) => `Research the attendees of this meeting.\n\nInput: ${JSON.stringify(input)}`
})

/** Finds past meetings and their open action items. */
export const GatherHistory = AgentAction.make("examples/MeetingBriefer/HistoryContext", {
  payload: { meetingTitle: Schema.String, attendees: Schema.Array(Schema.String), accountName: Schema.String },
  output: HistoryContext,
  seat,
  system: [
    `You are a meeting history researcher. Given a meeting title, its attendees, and the account,
find previous meetings with their topics and outcomes, and the action items still open.`
  ],
  prompt: (input) => `Gather the history behind this meeting.\n\nInput: ${JSON.stringify(input)}`
})

/** Writes the brief from the classification and the gathered context. */
export const WriteBrief = AgentAction.make("examples/MeetingBriefer/Brief", {
  payload: {
    meetingId: Schema.String,
    title: Schema.String,
    scheduledAt: Schema.String,
    intent: Schema.String,
    priority: Schema.String,
    flags: Schema.Array(Schema.String),
    crmContext: CrmContext,
    attendeeProfiles: AttendeeContext.fields.profiles,
    previousMeetings: HistoryContext.fields.previousMeetings,
    openActionItems: Schema.Array(Schema.String)
  },
  output: Brief,
  seat,
  system: [
    `You are an executive briefing writer. Given meeting classification, CRM context,
attendee profiles, and meeting history, synthesize a concise, actionable prep brief. Include
a headline, talking points, risks/flags, a suggested agenda, and open items. The brief should
be scannable in under 2 minutes.`
  ],
  prompt: (input) => `Write the prep brief for this meeting.\n\nInput: ${JSON.stringify(input)}`
})

/**
 * The flow: classify, gather the three contexts together, brief.
 *
 * The context steps wait for the classification with `Node.andThen`, as 0.x's
 * sequence did; only the CRM step reads it, and `Node.bindPlanned` alone would
 * let the other two start beside the classifier.
 */
export const MeetingBriefer = Flow.make("examples/MeetingBriefer", {
  payload: { event: MeetingEvent },
  success: Brief,
  error: AgentAction.AgentFailure,
  body: ({ event }) =>
    Node.bindPlanned(
      Classify.call({
        title: event.title,
        description: event.description ?? "",
        organizer: event.organizer,
        attendees: event.attendees,
        calendarSource: event.calendarSource
      }),
      (classification: Planned.Planned<typeof Classification.Type>) =>
        Node.andThen(
          Node.succeed(classification),
          Node.bindPlanned(
            Node.all({
              crm: GatherCrm.call({
                accountName: event.title,
                attendees: event.attendees,
                intent: classification.intent
              }),
              attendees: GatherAttendees.call({ attendees: event.attendees, organizer: event.organizer }),
              history: GatherHistory.call({
                meetingTitle: event.title,
                attendees: event.attendees,
                accountName: event.title
              })
            }),
            (context) =>
              WriteBrief.call({
                meetingId: event.meetingId,
                title: event.title,
                scheduledAt: event.scheduledAt,
                intent: classification.intent,
                priority: classification.priority,
                flags: classification.flags,
                crmContext: context.crm,
                attendeeProfiles: context.attendees.profiles,
                previousMeetings: context.history.previousMeetings,
                openActionItems: context.history.openActionItems
              })
          )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(
  Classify.layer,
  GatherCrm.layer,
  GatherAttendees.layer,
  GatherHistory.layer,
  WriteBrief.layer
)
