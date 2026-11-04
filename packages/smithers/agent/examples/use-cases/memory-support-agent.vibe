/**
 * Answer a support message from the customer's recalled memory, update that memory, and escalate when unsure.
 *
 * Port of the 0.x `memory-support-agent.jsx`. A recall agent loads the
 * customer's facts and recent tickets and reads their sentiment; a support
 * agent replies from them; a persistence agent then updates the customer's
 * facts from the exchange. Only a reply that asks for escalation goes on to the
 * escalation agent, which picks a tier and packages the context.
 *
 * 0.x's recall, respond, persist and escalate prompts were placeholders that printed their props; these prompts state the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools to reach the memory store; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`), and a host keeps customers apart by binding its `remember`/`recall` flows under a per-customer `WithMemory` policy (see `26-memory-recall.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One durable fact about a customer. */
export const MemoryEntry = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  updatedAt: Schema.String
})

/** What the recall agent loaded for one customer. */
export const Recall = Schema.Struct({
  customerId: Schema.String,
  facts: Schema.Array(MemoryEntry),
  recentTickets: Schema.Array(Schema.String),
  sentiment: Schema.Literals(["positive", "neutral", "frustrated", "angry"])
})

/** The support agent's reply. `confidenceScore` runs from 0 to 100. */
export const Response = Schema.Struct({
  reply: Schema.String,
  confidenceScore: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  needsEscalation: Schema.Boolean,
  reasoning: Schema.String,
  suggestedActions: Schema.Array(Schema.String)
})

/** How the persistence agent changed the customer's memory. */
export const Persist = Schema.Struct({
  customerId: Schema.String,
  newFacts: Schema.Array(MemoryEntry),
  removedKeys: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Where the escalation agent sent the interaction. */
export const Escalation = Schema.Struct({
  escalated: Schema.Boolean,
  tier: Schema.Literals(["t1", "t2", "t3", "engineering"]),
  reason: Schema.String,
  context: Schema.String,
  summary: Schema.String
})

/** What the flow settles with: every step's output, and `null` when nothing was escalated. */
export const Output = Schema.Struct({
  recall: Recall,
  response: Response,
  persist: Persist,
  escalation: Schema.NullOr(Escalation)
})

/** Loads one customer's memory and reads their sentiment. */
export const RecallMemory = AgentAction.make("examples/MemorySupportAgent/Recall", {
  payload: { customerId: Schema.String, conversationHistory: Schema.Array(Schema.Json) },
  output: Recall,
  seat,
  system: [
    `You are a memory retrieval specialist. Given a customer ID, load their
durable memory store and recent ticket history. Ensure strict isolation — never leak
facts from one customer into another's context. Assess current sentiment from the
conversation history.`
  ],
  prompt: ({ conversationHistory, customerId }) =>
    `Load the durable memory for one customer.\n\nCustomer: ${customerId}\nConversation history: ${
      JSON.stringify(conversationHistory)
    }`
})

/** Replies to the latest message from what recall loaded. */
export const Respond = AgentAction.make("examples/MemorySupportAgent/Respond", {
  payload: {
    customerId: Schema.String,
    facts: Schema.Array(MemoryEntry),
    recentTickets: Schema.Array(Schema.String),
    sentiment: Schema.String,
    latestMessage: Schema.String
  },
  output: Response,
  seat,
  system: [
    `You are a senior support agent. Use the customer's recalled memory and
known facts to craft a personalised, accurate reply. Leverage past preferences,
known issues, and account configuration. Flag low-confidence answers for escalation
rather than guessing.`
  ],
  prompt: ({ customerId, facts, latestMessage, recentTickets, sentiment }) =>
    `Reply to the customer's latest message.\n\nCustomer: ${customerId}\nSentiment: ${sentiment}\nLatest message: ${latestMessage}\nFacts: ${
      JSON.stringify(facts)
    }\nRecent tickets: ${JSON.stringify(recentTickets)}`
})

/** Updates the customer's memory from the reply. */
export const PersistMemory = AgentAction.make("examples/MemorySupportAgent/Persist", {
  payload: {
    customerId: Schema.String,
    existingFacts: Schema.Array(MemoryEntry),
    reply: Schema.String,
    latestMessage: Schema.String
  },
  output: Persist,
  seat,
  system: [
    `You are a memory persistence agent. After each support interaction,
extract new facts learned about the customer and update their durable memory store.
Remove stale or contradicted facts. Maintain strict per-customer isolation.`
  ],
  prompt: ({ customerId, existingFacts, latestMessage, reply }) =>
    `Update the customer's durable memory after this interaction.\n\nCustomer: ${customerId}\nLatest message: ${latestMessage}\nReply: ${reply}\nExisting facts: ${
      JSON.stringify(existingFacts)
    }`
})

/** Picks an escalation tier and packages the context for it. */
export const Escalate = AgentAction.make("examples/MemorySupportAgent/Escalate", {
  payload: {
    customerId: Schema.String,
    confidenceScore: Schema.Number,
    reasoning: Schema.String,
    suggestedActions: Schema.Array(Schema.String),
    sentiment: Schema.String,
    recentTickets: Schema.Array(Schema.String)
  },
  output: Escalation,
  seat,
  system: [
    `You are an escalation router. When a support interaction exceeds the
agent's confidence or requires specialised access, determine the correct escalation
tier and package the full context so the receiving team can act without re-asking
the customer.`
  ],
  prompt: ({ confidenceScore, customerId, reasoning, recentTickets, sentiment, suggestedActions }) =>
    `Escalate this support interaction.\n\nCustomer: ${customerId}\nConfidence score: ${confidenceScore}\nSentiment: ${sentiment}\nReasoning: ${reasoning}\nSuggested actions: ${
      JSON.stringify(suggestedActions)
    }\nRecent tickets: ${JSON.stringify(recentTickets)}`
})

type Requirements = Action.Requirement<
  | "examples/MemorySupportAgent/Recall"
  | "examples/MemorySupportAgent/Respond"
  | "examples/MemorySupportAgent/Persist"
  | "examples/MemorySupportAgent/Escalate"
>

/**
 * The escalation decision. Its subject reads the persisted memory, so, as in
 * 0.x's `<Sequence>`, escalation starts only after persistence has finished.
 */
const settle = (
  recall: Planned.Planned<typeof Recall.Type>,
  response: Planned.Planned<typeof Response.Type>,
  persist: Planned.Planned<typeof Persist.Type>
): Node.Node<typeof Output.Type, AgentAction.AgentFailure, Requirements> =>
  Node.branch(Node.succeed({ response, persist }), {
    if: (done) => done.response.needsEscalation,
    then: () =>
      Node.bindPlanned(
        Escalate.call({
          customerId: recall.customerId,
          confidenceScore: response.confidenceScore,
          reasoning: response.reasoning,
          suggestedActions: response.suggestedActions,
          sentiment: recall.sentiment,
          recentTickets: recall.recentTickets
        }),
        (escalation: Planned.Planned<typeof Escalation.Type>) => Node.succeed({ recall, response, persist, escalation })
      ),
    else: () => Node.succeed({ recall, response, persist, escalation: null })
  })

/** The flow: recall, respond, persist, and escalate when the reply asks for it. */
export const MemorySupportAgent = Flow.make("examples/MemorySupportAgent", {
  payload: {
    customerId: Schema.optional(Schema.String),
    conversationHistory: Schema.optional(Schema.Array(Schema.Json)),
    latestMessage: Schema.optional(Schema.String)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ conversationHistory = [], customerId = "unknown", latestMessage = "" }) =>
    Node.bindPlanned(
      RecallMemory.call({ customerId, conversationHistory }),
      (recall: Planned.Planned<typeof Recall.Type>) =>
        Node.bindPlanned(
          Respond.call({
            customerId: recall.customerId,
            facts: recall.facts,
            recentTickets: recall.recentTickets,
            sentiment: recall.sentiment,
            latestMessage
          }),
          (response: Planned.Planned<typeof Response.Type>) =>
            Node.bindPlanned(
              PersistMemory.call({
                customerId: recall.customerId,
                existingFacts: recall.facts,
                reply: response.reply,
                latestMessage
              }),
              (persist: Planned.Planned<typeof Persist.Type>) => settle(recall, response, persist)
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(RecallMemory.layer, Respond.layer, PersistMemory.layer, Escalate.layer)
