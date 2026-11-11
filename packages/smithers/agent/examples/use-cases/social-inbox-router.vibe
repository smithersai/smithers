/**
 * Classify a social inbox message as a lead, noise, support or follow-up, and draft the actions for each.
 *
 * Port of the 0.x `social-inbox-router.jsx`. A trigger step normalizes the
 * incoming messages into one inbox item, and a classifier agent labels it.
 * Three action agents then run side by side, each handed only the items in its
 * category: leads get a reply and a CRM action, support items a ticket, and
 * follow-ups a reply with a due date. All three run even when their list is
 * empty, as in 0.x. A summary step reports the counts and the handled ids.
 *
 * 0.x's `trigger` and `summary` tasks had a prompt but no agent, so they settled with the prompt element and only passed under mocks; here they are agent steps over the same props.
 * 0.x's `<Parallel maxConcurrency={3}>` held exactly three tasks, so `Node.all` runs them with the same effective bound.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One normalized inbox message. */
export const InboxItem = Schema.Struct({
  id: Schema.String,
  platform: Schema.Literals(["linkedin", "twitter", "facebook", "instagram", "other"]),
  senderName: Schema.String,
  senderTitle: Schema.optional(Schema.String),
  senderCompany: Schema.optional(Schema.String),
  messageBody: Schema.String,
  receivedAt: Schema.String,
  summary: Schema.String
})

/** One classified item. */
export const ClassifiedItem = Schema.Struct({
  id: Schema.String,
  category: Schema.Literals(["lead", "noise", "support", "follow-up"]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reasoning: Schema.String
})

/** The classifier's answer. */
export const Classification = Schema.Struct({ items: Schema.Array(ClassifiedItem), summary: Schema.String })

/** The lead agent's answer. */
export const LeadAction = Schema.Struct({
  actions: Schema.Array(Schema.Struct({
    itemId: Schema.String,
    senderName: Schema.String,
    senderCompany: Schema.optional(Schema.String),
    suggestedReply: Schema.String,
    crmAction: Schema.Literals(["create-contact", "update-contact", "create-opportunity"]),
    priority: Schema.Literals(["low", "medium", "high"])
  })),
  summary: Schema.String
})

/** The support agent's answer. */
export const SupportAction = Schema.Struct({
  tickets: Schema.Array(Schema.Struct({
    itemId: Schema.String,
    subject: Schema.String,
    urgency: Schema.Literals(["low", "medium", "high", "critical"]),
    suggestedReply: Schema.String,
    escalate: Schema.Boolean
  })),
  summary: Schema.String
})

/** The follow-up agent's answer. */
export const FollowUpAction = Schema.Struct({
  followUps: Schema.Array(Schema.Struct({
    itemId: Schema.String,
    senderName: Schema.String,
    context: Schema.String,
    suggestedReply: Schema.String,
    dueBy: Schema.String
  })),
  summary: Schema.String
})

/** The routing summary the flow settles with. */
export const RouterOutput = Schema.Struct({
  totalProcessed: Schema.Number,
  categoryCounts: Schema.Struct({
    lead: Schema.Number,
    noise: Schema.Number,
    support: Schema.Number,
    followUp: Schema.Number
  }),
  leadActions: Schema.Array(Schema.String),
  supportTickets: Schema.Array(Schema.String),
  followUps: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Normalizes the incoming messages into one inbox item. */
export const NormalizeMessage = AgentAction.make("examples/SocialInboxRouter/Trigger", {
  payload: { messages: Schema.Array(Schema.Json), platform: Schema.String },
  output: InboxItem,
  seat,
  prompt: ({ messages, platform }) =>
    `Normalize this social message into an inbox item.\n\nPlatform: ${platform}\nMessages: ${JSON.stringify(messages)}`
})

/** Labels each item lead, noise, support or follow-up. */
export const Classify = AgentAction.make("examples/SocialInboxRouter/Classify", {
  payload: { items: Schema.Array(InboxItem) },
  output: Classification,
  seat,
  system: [
    `You are a social inbox classifier. Given a batch of social messages,
categorize each as lead (buying intent, demo requests, partnership inquiries),
noise (congratulations, spam, irrelevant), support (bug reports, billing issues,
feature complaints), or follow-up (ongoing conversations needing a response).
Return a confidence score and brief reasoning for each classification.`
  ],
  prompt: ({ items }) => `Classify these inbox items.\n\nItems: ${JSON.stringify(items)}`
})

/** Drafts replies and CRM actions for the leads. */
export const LeadActions = AgentAction.make("examples/SocialInboxRouter/LeadActions", {
  payload: { leads: Schema.Array(ClassifiedItem), senderContext: Schema.Json },
  output: LeadAction,
  seat,
  system: [
    `You are a sales development assistant. For each identified lead,
draft a personalized reply, determine the appropriate CRM action, and assign a
priority level based on the sender's title, company, and message intent.`
  ],
  prompt: ({ leads, senderContext }) =>
    `Draft actions for these leads.\n\nLeads: ${JSON.stringify(leads)}\nSender context: ${
      JSON.stringify(senderContext)
    }`
})

/** Opens tickets for the support items. */
export const SupportActions = AgentAction.make("examples/SocialInboxRouter/SupportActions", {
  payload: { supportItems: Schema.Array(ClassifiedItem), productContext: Schema.Json },
  output: SupportAction,
  seat,
  system: [
    `You are a support triage specialist. For each support message,
create a ticket with a subject line, determine urgency, draft a helpful initial
reply, and flag whether escalation to engineering is needed.`
  ],
  prompt: ({ productContext, supportItems }) =>
    `Open tickets for these support items.\n\nSupport items: ${JSON.stringify(supportItems)}\nProduct context: ${
      JSON.stringify(productContext)
    }`
})

/** Drafts replies with due dates for the follow-ups. */
export const FollowUpActions = AgentAction.make("examples/SocialInboxRouter/FollowUpActions", {
  payload: { followUps: Schema.Array(ClassifiedItem), relationshipContext: Schema.Json },
  output: FollowUpAction,
  seat,
  system: [
    `You are a relationship manager. For each follow-up item,
provide context on the conversation history, draft a thoughtful reply, and
set a due-by date to keep the relationship warm.`
  ],
  prompt: ({ followUps, relationshipContext }) =>
    `Draft follow-ups for these items.\n\nFollow-ups: ${JSON.stringify(followUps)}\nRelationship context: ${
      JSON.stringify(relationshipContext)
    }`
})

/** Summarizes what was routed where. */
export const Summarize = AgentAction.make("examples/SocialInboxRouter/Summary", {
  payload: {
    classified: Classification,
    leadActions: LeadAction,
    supportActions: SupportAction,
    followUpActions: FollowUpAction
  },
  output: RouterOutput,
  seat,
  prompt: ({ classified, followUpActions, leadActions, supportActions }) =>
    `Summarize the routing results.\n\nClassified: ${JSON.stringify(classified)}\nLead actions: ${
      JSON.stringify(leadActions)
    }\nSupport actions: ${JSON.stringify(supportActions)}\nFollow-up actions: ${JSON.stringify(followUpActions)}`
})

type Classification = typeof Classification.Type

/** Splits the classified items by category. Pure, so it is a `Node.map`, not a step. */
const sort = ({ items }: Classification) => ({
  leads: items.filter((item) => item.category === "lead"),
  supportItems: items.filter((item) => item.category === "support"),
  followUps: items.filter((item) => item.category === "follow-up")
})

/** The flow: normalize, classify, draft the three kinds of action side by side, summarize. */
export const SocialInboxRouter = Flow.make("examples/SocialInboxRouter", {
  payload: {
    messages: Schema.optional(Schema.Array(Schema.Json)),
    platform: Schema.optional(Schema.String),
    senderContext: Schema.optional(Schema.Json),
    productContext: Schema.optional(Schema.Json),
    relationshipContext: Schema.optional(Schema.Json)
  },
  success: RouterOutput,
  error: AgentAction.AgentFailure,
  body: ({ messages = [], platform = "linkedin", productContext = {}, relationshipContext = {}, senderContext = {} }) =>
    Node.bindPlanned(
      NormalizeMessage.call({ messages, platform }),
      (item: Planned.Planned<typeof InboxItem.Type>) =>
        Node.bindPlanned(
          Classify.call({ items: [item] }),
          (classified: Planned.Planned<Classification>) =>
            Node.bindPlanned(
              Node.map(Node.succeed(classified), sort),
              (sorted: Planned.Planned<ReturnType<typeof sort>>) =>
                Node.bindPlanned(
                  Node.all({
                    lead: LeadActions.call({ leads: sorted.leads, senderContext }),
                    support: SupportActions.call({ supportItems: sorted.supportItems, productContext }),
                    followUp: FollowUpActions.call({ followUps: sorted.followUps, relationshipContext })
                  }),
                  (actions) =>
                    Summarize.call({
                      classified,
                      leadActions: actions.lead,
                      supportActions: actions.support,
                      followUpActions: actions.followUp
                    })
                )
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(
  NormalizeMessage.layer,
  Classify.layer,
  LeadActions.layer,
  SupportActions.layer,
  FollowUpActions.layer,
  Summarize.layer
)
