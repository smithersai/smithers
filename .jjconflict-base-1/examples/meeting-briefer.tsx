// @ts-nocheck
/**
 * <MeetingBriefer> — Watch scheduled meetings, classify intent, gather CRM/context,
 * and create a prep brief for the attendee.
 *
 * Shape: calendar/booking trigger → classifier → context gatherers → briefing agent.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import TriggerPrompt from "./prompts/meeting-briefer/trigger.mdx";
import ClassifyPrompt from "./prompts/meeting-briefer/classify.mdx";
import CrmContextPrompt from "./prompts/meeting-briefer/crm-context.mdx";
import AttendeeContextPrompt from "./prompts/meeting-briefer/attendee-context.mdx";
import HistoryContextPrompt from "./prompts/meeting-briefer/history-context.mdx";
import BriefPrompt from "./prompts/meeting-briefer/brief.mdx";

const meetingEventSchema = z.object({
  meetingId: z.string(),
  title: z.string(),
  organizer: z.string(),
  attendees: z.array(z.string()),
  scheduledAt: z.string(),
  calendarSource: z.enum(["google", "outlook", "calendly", "hubspot", "other"]),
  description: z.string().optional(),
  summary: z.string(),
});

const classificationSchema = z.object({
  intent: z.enum([
    "discovery",
    "demo",
    "renewal",
    "upsell",
    "support-escalation",
    "internal-sync",
    "partnership",
    "other",
  ]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  accountTier: z.enum(["free", "starter", "growth", "enterprise"]).optional(),
  flags: z.array(z.string()),
  summary: z.string(),
});

const crmContextSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  opportunityStage: z.string().optional(),
  arr: z.number().optional(),
  ownerName: z.string(),
  openTickets: z.number(),
  lastTouchDate: z.string().optional(),
  notes: z.array(z.string()),
  summary: z.string(),
});

const attendeeContextSchema = z.object({
  profiles: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      role: z.enum(["champion", "decision-maker", "influencer", "end-user", "unknown"]),
      linkedinUrl: z.string().optional(),
      recentActivity: z.string().optional(),
    })
  ),
  summary: z.string(),
});

const historyContextSchema = z.object({
  previousMeetings: z.array(
    z.object({
      date: z.string(),
      topic: z.string(),
      outcome: z.string(),
    })
  ),
  openActionItems: z.array(z.string()),
  summary: z.string(),
});

const briefSchema = z.object({
  meetingId: z.string(),
  headline: z.string(),
  intent: z.string(),
  priority: z.string(),
  accountSnapshot: z.string(),
  attendeeSummary: z.string(),
  talkingPoints: z.array(z.string()),
  risksAndFlags: z.array(z.string()),
  suggestedAgenda: z.array(z.string()),
  openItems: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  meetingEvent: meetingEventSchema,
  classification: classificationSchema,
  crmContext: crmContextSchema,
  attendeeContext: attendeeContextSchema,
  historyContext: historyContextSchema,
  brief: briefSchema,
});

const classifierAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a meeting intent classifier. Given a calendar event with its title,
description, attendees, and source, determine the meeting intent, priority level, account tier,
and any flags (e.g. at-risk renewal, executive attendee, competitor mentioned). Be precise
and use all available signals.`,
});

const crmAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a CRM context gatherer. Given an account name and attendees,
pull the relevant account record, opportunity stage, ARR, owner, open support tickets,
last touch date, and recent CRM notes. Summarize the account health concisely.`,
});

const attendeeAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are an attendee research specialist. Given a list of meeting attendees,
look up each person's title, role in the buying process, LinkedIn profile, and any recent
activity or engagement signals. Classify each attendee's influence level.`,
});

const briefingAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are an executive briefing writer. Given meeting classification, CRM context,
attendee profiles, and meeting history, synthesize a concise, actionable prep brief. Include
a headline, talking points, risks/flags, a suggested agenda, and open items. The brief should
be scannable in under 2 minutes.`,
});

export default smithers((ctx) => {
  const event = ctx.outputMaybe("meetingEvent", { nodeId: "trigger" });
  const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
  const crm = ctx.outputMaybe("crmContext", { nodeId: "crm-context" });
  const attendees = ctx.outputMaybe("attendeeContext", { nodeId: "attendee-context" });
  const history = ctx.outputMaybe("historyContext", { nodeId: "history-context" });

  return (
    <Workflow name="meeting-briefer">
      <Sequence>
        {/* Stage 1: Ingest the calendar/booking trigger */}
        <Task id="trigger" output={outputs.meetingEvent}>
          <TriggerPrompt
            event={ctx.input.event ?? {}}
            source={ctx.input.source ?? "other"}
          />
        </Task>

        {/* Stage 2: Classify intent and priority */}
        <Task id="classify" output={outputs.classification} agent={classifierAgent}>
          <ClassifyPrompt
            title={event?.title ?? ""}
            description={event?.description ?? ""}
            organizer={event?.organizer ?? ""}
            attendees={event?.attendees ?? []}
            calendarSource={event?.calendarSource ?? "other"}
          />
        </Task>

        {/* Stage 3: Gather context in parallel */}
        <Parallel maxConcurrency={3}>
          <Task id="crm-context" output={outputs.crmContext} agent={crmAgent}>
            <CrmContextPrompt
              accountName={event?.title ?? ""}
              attendees={event?.attendees ?? []}
              intent={classification?.intent ?? "other"}
            />
          </Task>

          <Task id="attendee-context" output={outputs.attendeeContext} agent={attendeeAgent}>
            <AttendeeContextPrompt
              attendees={event?.attendees ?? []}
              organizer={event?.organizer ?? ""}
            />
          </Task>

          <Task id="history-context" output={outputs.historyContext}>
            <HistoryContextPrompt
              meetingTitle={event?.title ?? ""}
              attendees={event?.attendees ?? []}
              accountName={crm?.accountName ?? event?.title ?? ""}
            />
          </Task>
        </Parallel>

        {/* Stage 4: Synthesize the prep brief */}
        <Task id="brief" output={outputs.brief} agent={briefingAgent}>
          <BriefPrompt
            meetingId={event?.meetingId ?? ""}
            title={event?.title ?? ""}
            scheduledAt={event?.scheduledAt ?? ""}
            intent={classification?.intent ?? "other"}
            priority={classification?.priority ?? "medium"}
            flags={classification?.flags ?? []}
            crmContext={crm ?? {}}
            attendeeProfiles={attendees?.profiles ?? []}
            previousMeetings={history?.previousMeetings ?? []}
            openActionItems={history?.openActionItems ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
