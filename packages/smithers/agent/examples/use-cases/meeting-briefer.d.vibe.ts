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
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The meeting the trigger fired for. */
export declare const MeetingEvent: Schema.Struct<{
    readonly meetingId: Schema.String;
    readonly title: Schema.String;
    readonly organizer: Schema.String;
    readonly attendees: Schema.$Array<Schema.String>;
    readonly scheduledAt: Schema.String;
    readonly calendarSource: Schema.Literals<readonly ["google", "outlook", "calendly", "hubspot", "other"]>;
    readonly description: Schema.optional<Schema.String>;
    readonly summary: Schema.String;
}>;
/** What the meeting is for, and how much it matters. */
export declare const Classification: Schema.Struct<{
    readonly intent: Schema.Literals<readonly ["discovery", "demo", "renewal", "upsell", "support-escalation", "internal-sync", "partnership", "other"]>;
    readonly priority: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly accountTier: Schema.optional<Schema.Literals<readonly ["free", "starter", "growth", "enterprise"]>>;
    readonly flags: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The account's CRM record. */
export declare const CrmContext: Schema.Struct<{
    readonly accountId: Schema.String;
    readonly accountName: Schema.String;
    readonly opportunityStage: Schema.optional<Schema.String>;
    readonly arr: Schema.optional<Schema.Number>;
    readonly ownerName: Schema.String;
    readonly openTickets: Schema.Number;
    readonly lastTouchDate: Schema.optional<Schema.String>;
    readonly notes: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Who is coming, and their role in the deal. */
export declare const AttendeeContext: Schema.Struct<{
    readonly profiles: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly title: Schema.String;
        readonly role: Schema.Literals<readonly ["champion", "decision-maker", "influencer", "end-user", "unknown"]>;
        readonly linkedinUrl: Schema.optional<Schema.String>;
        readonly recentActivity: Schema.optional<Schema.String>;
    }>>;
    readonly summary: Schema.String;
}>;
/** Past meetings and what is still open from them. */
export declare const HistoryContext: Schema.Struct<{
    readonly previousMeetings: Schema.$Array<Schema.Struct<{
        readonly date: Schema.String;
        readonly topic: Schema.String;
        readonly outcome: Schema.String;
    }>>;
    readonly openActionItems: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The prep brief the flow settles with. */
export declare const Brief: Schema.Struct<{
    readonly meetingId: Schema.String;
    readonly headline: Schema.String;
    readonly intent: Schema.String;
    readonly priority: Schema.String;
    readonly accountSnapshot: Schema.String;
    readonly attendeeSummary: Schema.String;
    readonly talkingPoints: Schema.$Array<Schema.String>;
    readonly risksAndFlags: Schema.$Array<Schema.String>;
    readonly suggestedAgenda: Schema.$Array<Schema.String>;
    readonly openItems: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Reads the meeting's intent, priority and flags. */
export declare const Classify: AgentAction.AgentAction<"examples/MeetingBriefer/Classify", Schema.Struct<{
    title: Schema.String;
    description: Schema.String;
    organizer: Schema.String;
    attendees: Schema.$Array<Schema.String>;
    calendarSource: Schema.String;
}>, Schema.Struct<{
    readonly intent: Schema.Literals<readonly ["discovery", "demo", "renewal", "upsell", "support-escalation", "internal-sync", "partnership", "other"]>;
    readonly priority: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly accountTier: Schema.optional<Schema.Literals<readonly ["free", "starter", "growth", "enterprise"]>>;
    readonly flags: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Pulls the account's CRM record. */
export declare const GatherCrm: AgentAction.AgentAction<"examples/MeetingBriefer/CrmContext", Schema.Struct<{
    accountName: Schema.String;
    attendees: Schema.$Array<Schema.String>;
    intent: Schema.String;
}>, Schema.Struct<{
    readonly accountId: Schema.String;
    readonly accountName: Schema.String;
    readonly opportunityStage: Schema.optional<Schema.String>;
    readonly arr: Schema.optional<Schema.Number>;
    readonly ownerName: Schema.String;
    readonly openTickets: Schema.Number;
    readonly lastTouchDate: Schema.optional<Schema.String>;
    readonly notes: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Researches each attendee. */
export declare const GatherAttendees: AgentAction.AgentAction<"examples/MeetingBriefer/AttendeeContext", Schema.Struct<{
    attendees: Schema.$Array<Schema.String>;
    organizer: Schema.String;
}>, Schema.Struct<{
    readonly profiles: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly title: Schema.String;
        readonly role: Schema.Literals<readonly ["champion", "decision-maker", "influencer", "end-user", "unknown"]>;
        readonly linkedinUrl: Schema.optional<Schema.String>;
        readonly recentActivity: Schema.optional<Schema.String>;
    }>>;
    readonly summary: Schema.String;
}>>;
/** Finds past meetings and their open action items. */
export declare const GatherHistory: AgentAction.AgentAction<"examples/MeetingBriefer/HistoryContext", Schema.Struct<{
    meetingTitle: Schema.String;
    attendees: Schema.$Array<Schema.String>;
    accountName: Schema.String;
}>, Schema.Struct<{
    readonly previousMeetings: Schema.$Array<Schema.Struct<{
        readonly date: Schema.String;
        readonly topic: Schema.String;
        readonly outcome: Schema.String;
    }>>;
    readonly openActionItems: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Writes the brief from the classification and the gathered context. */
export declare const WriteBrief: AgentAction.AgentAction<"examples/MeetingBriefer/Brief", Schema.Struct<{
    meetingId: Schema.String;
    title: Schema.String;
    scheduledAt: Schema.String;
    intent: Schema.String;
    priority: Schema.String;
    flags: Schema.$Array<Schema.String>;
    crmContext: Schema.Struct<{
        readonly accountId: Schema.String;
        readonly accountName: Schema.String;
        readonly opportunityStage: Schema.optional<Schema.String>;
        readonly arr: Schema.optional<Schema.Number>;
        readonly ownerName: Schema.String;
        readonly openTickets: Schema.Number;
        readonly lastTouchDate: Schema.optional<Schema.String>;
        readonly notes: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>;
    attendeeProfiles: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly title: Schema.String;
        readonly role: Schema.Literals<readonly ["champion", "decision-maker", "influencer", "end-user", "unknown"]>;
        readonly linkedinUrl: Schema.optional<Schema.String>;
        readonly recentActivity: Schema.optional<Schema.String>;
    }>>;
    previousMeetings: Schema.$Array<Schema.Struct<{
        readonly date: Schema.String;
        readonly topic: Schema.String;
        readonly outcome: Schema.String;
    }>>;
    openActionItems: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly meetingId: Schema.String;
    readonly headline: Schema.String;
    readonly intent: Schema.String;
    readonly priority: Schema.String;
    readonly accountSnapshot: Schema.String;
    readonly attendeeSummary: Schema.String;
    readonly talkingPoints: Schema.$Array<Schema.String>;
    readonly risksAndFlags: Schema.$Array<Schema.String>;
    readonly suggestedAgenda: Schema.$Array<Schema.String>;
    readonly openItems: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/**
 * The flow: classify, gather the three contexts together, brief.
 *
 * The context steps wait for the classification with `Node.andThen`, as 0.x's
 * sequence did; only the CRM step reads it, and `Node.bindPlanned` alone would
 * let the other two start beside the classifier.
 */
export declare const MeetingBriefer: Flow.Flow<"examples/MeetingBriefer", Schema.Struct<{
    event: Schema.Struct<{
        readonly meetingId: Schema.String;
        readonly title: Schema.String;
        readonly organizer: Schema.String;
        readonly attendees: Schema.$Array<Schema.String>;
        readonly scheduledAt: Schema.String;
        readonly calendarSource: Schema.Literals<readonly ["google", "outlook", "calendly", "hubspot", "other"]>;
        readonly description: Schema.optional<Schema.String>;
        readonly summary: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly meetingId: Schema.String;
    readonly headline: Schema.String;
    readonly intent: Schema.String;
    readonly priority: Schema.String;
    readonly accountSnapshot: Schema.String;
    readonly attendeeSummary: Schema.String;
    readonly talkingPoints: Schema.$Array<Schema.String>;
    readonly risksAndFlags: Schema.$Array<Schema.String>;
    readonly suggestedAgenda: Schema.$Array<Schema.String>;
    readonly openItems: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/AttendeeContext"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/Brief"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/CrmContext"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/HistoryContext">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/AttendeeContext"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/Brief"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/CrmContext"> | import("@smthrs/flow/Action").Requirement<"examples/MeetingBriefer/HistoryContext">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
