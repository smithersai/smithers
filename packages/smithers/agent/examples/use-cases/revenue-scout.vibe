/**
 * Scan conversations for latent sales opportunities and hand them to sales reps.
 *
 * Port of the 0.x `revenue-scout.jsx`. A classifier agent marks each support,
 * form or email conversation with a revenue signal or none. Only when some
 * conversation carries a signal does an extractor agent pull structured
 * opportunities from the flagged ones. A handoff agent then assigns reps and
 * priorities, told how many conversations were scanned, and runs with no
 * opportunities when nothing was flagged.
 *
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const SignalType = Schema.Literals(["upsell", "expansion", "cross-sell", "renewal"])

/** One classified conversation. */
export const Conversation = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["support", "form", "email"]),
  hasSignal: Schema.Boolean,
  signalType: Schema.Literals(["upsell", "expansion", "cross-sell", "renewal", "none"]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reasoning: Schema.String
})

/** The classifier's answer. */
export const Classification = Schema.Struct({ conversations: Schema.Array(Conversation) })

/** One opportunity pulled from a flagged conversation. */
export const Opportunity = Schema.Struct({
  conversationId: Schema.String,
  signalType: SignalType,
  product: Schema.String,
  customerName: Schema.String,
  accountId: Schema.optional(Schema.String),
  estimatedValue: Schema.optional(Schema.String),
  keyQuotes: Schema.Array(Schema.String),
  urgency: Schema.Literals(["immediate", "near-term", "exploratory"]),
  summary: Schema.String
})

/** The extractor's answer. */
export const Extraction = Schema.Struct({ opportunities: Schema.Array(Opportunity) })

/** The handoff the flow settles with. */
export const Handoff = Schema.Struct({
  totalScanned: Schema.Number,
  opportunitiesFound: Schema.Number,
  routedToCrm: Schema.Number,
  bySignalType: Schema.Record(Schema.String, Schema.Number),
  handoffs: Schema.Array(Schema.Struct({
    conversationId: Schema.String,
    assignedRep: Schema.String,
    priority: Schema.Literals(["hot", "warm", "cool"]),
    nextStep: Schema.String
  })),
  summary: Schema.String
})

/** Marks each conversation with a revenue signal or none. */
export const Classify = AgentAction.make("examples/RevenueScout/Classify", {
  payload: {
    source: Schema.String,
    conversations: Schema.NullOr(Schema.Array(Schema.Json)),
    fetchCmd: Schema.NullOr(Schema.String)
  },
  output: Classification,
  seat,
  system: [
    `You are a revenue signal classifier. Scan support conversations,
form submissions, and email threads for latent sales opportunities.
Look for expansion intent, feature requests tied to growth, multi-team rollout
language, budget mentions, competitor comparisons, and renewal timing cues.
Mark conversations with no signal as "none".`
  ],
  prompt: ({ conversations, fetchCmd, source }) =>
    `Classify these conversations for revenue signals.\n\nSource: ${source}\nConversations: ${
      JSON.stringify(conversations)
    }\nFetch command: ${fetchCmd ?? "none"}`
})

/** Pulls structured opportunities from the flagged conversations. */
export const Extract = AgentAction.make("examples/RevenueScout/Extract", {
  payload: { flaggedConversations: Schema.Array(Conversation), accountContext: Schema.NullOr(Schema.Json) },
  output: Extraction,
  seat,
  system: [
    `You are a sales intelligence extractor. For each flagged conversation,
extract structured opportunity data: customer details, signal type, product interest,
key quotes, and estimated deal urgency. Be precise — sales reps will act on this.`
  ],
  prompt: ({ accountContext, flaggedConversations }) =>
    `Extract the opportunities in these flagged conversations.\n\nFlagged conversations: ${
      JSON.stringify(flaggedConversations)
    }\nAccount context: ${JSON.stringify(accountContext)}`
})

/** Assigns each opportunity a rep and a priority. */
export const HandOff = AgentAction.make("examples/RevenueScout/Handoff", {
  payload: {
    opportunities: Schema.Array(Opportunity),
    totalScanned: Schema.Number,
    crmTarget: Schema.String,
    teamMapping: Schema.NullOr(Schema.Json)
  },
  output: Handoff,
  seat,
  system: [
    `You are a CRM handoff coordinator. Take extracted opportunities and
prepare them for sales team routing. Assign priority based on urgency and estimated
value. Map each opportunity to the appropriate sales rep or queue.`
  ],
  prompt: ({ crmTarget, opportunities, teamMapping, totalScanned }) =>
    `Route these opportunities to sales.\n\nOpportunities: ${
      JSON.stringify(opportunities)
    }\nTotal scanned: ${totalScanned}\nCRM target: ${crmTarget}\nTeam mapping: ${JSON.stringify(teamMapping)}`
})

/** The flagged conversations and how many were scanned. Pure, so it is a `Node.map`. */
const scan = ({ conversations }: typeof Classification.Type) => ({
  flagged: conversations.filter((conversation) => conversation.hasSignal),
  totalScanned: conversations.length
})

/** The flow: classify, extract when anything was flagged, hand off. */
export const RevenueScout = Flow.make("examples/RevenueScout", {
  payload: {
    source: Schema.optional(Schema.String),
    conversations: Schema.optional(Schema.Array(Schema.Json)),
    fetchCmd: Schema.optional(Schema.String),
    accountContext: Schema.optional(Schema.Json),
    crmTarget: Schema.optional(Schema.String),
    teamMapping: Schema.optional(Schema.Json)
  },
  success: Handoff,
  error: AgentAction.AgentFailure,
  body: ({ accountContext, conversations, crmTarget = "salesforce", fetchCmd, source = "support", teamMapping }) => {
    const handOff = (
      opportunities: Planned.Planned<ReadonlyArray<typeof Opportunity.Type>> | ReadonlyArray<never>,
      totalScanned: Planned.Planned<number>
    ) => HandOff.call({ opportunities, totalScanned, crmTarget, teamMapping: teamMapping ?? null })
    return Node.branch(
      Node.map(Classify.call({ source, conversations: conversations ?? null, fetchCmd: fetchCmd ?? null }), scan),
      {
        if: ({ flagged }) => flagged.length > 0,
        then: (scanned) =>
          Node.bindPlanned(
            Extract.call({ flaggedConversations: scanned.flagged, accountContext: accountContext ?? null }),
            (extraction: Planned.Planned<typeof Extraction.Type>) =>
              handOff(extraction.opportunities, scanned.totalScanned)
          ),
        else: (scanned) => handOff([], scanned.totalScanned)
      }
    )
  }
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Classify.layer, Extract.layer, HandOff.layer)
