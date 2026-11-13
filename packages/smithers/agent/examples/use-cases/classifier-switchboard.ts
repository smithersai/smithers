/**
 * Normalize incoming items, classify each into one domain, and dispatch it to that domain's handler.
 *
 * Port of the 0.x `classifier-switchboard.jsx`. An intake agent normalizes the
 * items it is given, or the ones `fetchCmd` lists. A classifier agent assigns
 * each item exactly one of four domains with a priority. Each classified item
 * goes to its domain's handler agent, five at a time, and a failing handler
 * drops only its own result. The classifier's agent then summarizes the
 * switchboard's results.
 *
 * 0.x re-rendered its tree once the classification landed; here the handlers run in a `.child()` flow whose body plans over the real classifications.
 * 0.x's intake, classify, domain and summary prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the intake and domain handlers `read`, `bash` and `grep`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The four domains, in the order the classifier is told them. */
export const domains = ["support", "sales", "security", "billing"] as const

const Domain = Schema.Literals(domains)
const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** One normalized item. */
export const IntakeItem = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  source: Schema.Literals(["email", "chat", "ticket", "file"]),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

/** What intake produced. */
export const Intake = Schema.Struct({ items: Schema.Array(IntakeItem) })

/** One item's domain. */
export const Classified = Schema.Struct({
  itemId: Schema.String,
  domain: Domain,
  confidence: Fraction,
  reasoning: Schema.String,
  priority: Schema.Literals(["critical", "high", "normal", "low"])
})

/** The classifier's answer. */
export const Classification = Schema.Struct({ classifications: Schema.Array(Classified) })

/** What one domain handler did with its item. */
export const HandlerResult = Schema.Struct({
  itemId: Schema.String,
  domain: Domain,
  action: Schema.String,
  status: Schema.Literals(["resolved", "escalated", "pending"]),
  response: Schema.String
})

/** The summary the flow settles with. */
export const Summary = Schema.Struct({
  totalProcessed: Schema.Number,
  byDomain: Schema.Record(Schema.String, Schema.Number),
  byStatus: Schema.Record(Schema.String, Schema.Number),
  escalations: Schema.Array(Schema.Struct({
    itemId: Schema.String,
    domain: Schema.String,
    reason: Schema.String
  })),
  summary: Schema.String
})

type IntakeItem = typeof IntakeItem.Type
type Classified = typeof Classified.Type
type HandlerResult = typeof HandlerResult.Type

/** Normalizes the items it is given, or the ones `fetchCmd` lists. */
export const IntakeStep = AgentAction.make("examples/ClassifierSwitchboard/Intake", {
  payload: {
    source: Schema.String,
    items: Schema.NullOr(Schema.Array(Schema.Json)),
    fetchCmd: Schema.NullOr(Schema.String)
  },
  output: Intake,
  seat,
  system: [
    `You are an intake processor. Normalize incoming messages, tickets, and files
into a structured format for classification. Extract key content and metadata.`
  ],
  prompt: ({ fetchCmd, items, source }) =>
    `Normalize these incoming items.\n\nSource: ${source}\n${
      items !== null
        ? `Items: ${JSON.stringify(items)}`
        : fetchCmd !== null
        ? `Command to fetch items: ${fetchCmd}`
        : "No items or fetch command were given."
    }`
})

/** The classifier's instructions, which the summary step reuses as 0.x did. */
const classifierSystem = `You are a classifier. Assign each item to exactly one domain: support, sales,
security, or billing. Provide a confidence score and priority level.
Be decisive — pick the single best domain even when items touch multiple areas.`

/** Assigns each normalized item one domain. */
export const Classify = AgentAction.make("examples/ClassifierSwitchboard/Classify", {
  payload: { items: Schema.Array(IntakeItem), domains: Schema.Array(Schema.String) },
  output: Classification,
  seat,
  system: [classifierSystem],
  prompt: ({ domains, items }) =>
    `Classify each item into one of these domains: ${domains.join(", ")}.\n\nItems: ${JSON.stringify(items)}`
})

/** The props each domain prompt was rendered with. */
const HandlerPayload = Schema.Struct({
  itemId: Schema.String,
  content: Schema.String,
  priority: Classified.fields.priority,
  confidence: Schema.Number,
  reasoning: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.String)
})

const handler = <const Tag extends string>(tag: Tag, domain: string, role: string) =>
  AgentAction.make(tag, {
    payload: HandlerPayload,
    output: HandlerResult,
    seat,
    system: [
      `You are the ${role} handler. Process the routed item according to
${role} best practices. Resolve if possible, otherwise escalate with clear reasoning.`
    ],
    prompt: ({ confidence, content, itemId, metadata, priority, reasoning }) =>
      `Handle this ${priority} ${domain} item.\n\nItem: ${itemId}\nContent: ${content}\nClassifier confidence: ${confidence}\nReasoning: ${reasoning}\nMetadata: ${
        JSON.stringify(metadata)
      }`
  })

/** One handler per domain. */
export const handlers = {
  support: handler("examples/ClassifierSwitchboard/HandleSupport", "support", "customer support"),
  sales: handler("examples/ClassifierSwitchboard/HandleSales", "sales", "sales inquiry"),
  security: handler("examples/ClassifierSwitchboard/HandleSecurity", "security", "security incident"),
  billing: handler("examples/ClassifierSwitchboard/HandleBilling", "billing", "billing")
}

type HandlerTag = `examples/ClassifierSwitchboard/Handle${"Support" | "Sales" | "Security" | "Billing"}`

/** The handler call for one classified item, annotated so the four handlers' calls are one node type. */
const route = (
  classified: Classified,
  item: IntakeItem | undefined
): Node.Node<HandlerResult, AgentAction.AgentFailure, Action.Requirement<HandlerTag>> =>
  handlers[classified.domain].call({
    itemId: classified.itemId,
    content: item?.content ?? "",
    priority: classified.priority,
    confidence: classified.confidence,
    reasoning: classified.reasoning,
    metadata: item?.metadata ?? {}
  })

/**
 * The switchboard. It runs as a child execution, so its payload is real when
 * its body plans: each classification picks its handler directly instead of
 * branching on a planned value.
 */
export const Switchboard = Flow.make("examples/ClassifierSwitchboard/Switchboard", {
  description: "Route each classified item to its selected handler.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  modelInvocable: true,
  payload: { items: Schema.Array(IntakeItem), classifications: Schema.Array(Classified) },
  success: Schema.Array(HandlerResult),
  body: Node.capture({}, ({ classifications, items }) => {
    if (classifications.length === 0) return Node.succeed([])
    // 0.x `continueOnFail`: a failed handler settles as null instead of failing its siblings.
    const members = Object.fromEntries(classifications.map((classified) => [
      `handle-${classified.domain}-${classified.itemId}`,
      Node.catch(route(classified, items.find((item) => item.id === classified.itemId)), {
        onFailure: Node.capture({}, () => Node.succeed(null))
      })
    ]))
    const joined = Bounded.all(members, { concurrency: 5 })
    return Node.map(joined, Node.capture({}, (handled) => Object.values(handled).filter(Schema.is(HandlerResult))))
  })
})

/** Summarizes the switchboard's results. 0.x ran it on the classifier's agent, so it keeps those instructions. */
export const Summarize = AgentAction.make("examples/ClassifierSwitchboard/Summarize", {
  payload: {
    classifications: Schema.Array(Classified),
    results: Schema.Array(HandlerResult),
    totalItems: Schema.Number
  },
  output: Summary,
  seat,
  system: [classifierSystem],
  prompt: ({ classifications, results, totalItems }) =>
    `Summarize the switchboard run over ${totalItems} items.\n\nClassifications: ${
      JSON.stringify(classifications)
    }\nResults: ${JSON.stringify(results)}`
})

/** The flow: intake, classify, dispatch, summarize. */
export const ClassifierSwitchboard = Flow.make("examples/ClassifierSwitchboard", {
  description: "Normalize incoming items, classify each into one domain, and dispatch it to that domain's handler.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  modelInvocable: true,
  payload: {
    source: Schema.optional(Schema.String),
    items: Schema.optional(Schema.Array(Schema.Json)),
    fetchCmd: Schema.optional(Schema.String)
  },
  success: Summary,
  error: AgentAction.AgentFailure,
  body: Node.capture({}, ({ fetchCmd, items, source = "mixed" }) =>
    Node.bindPlanned(
      IntakeStep.call({ source, items: items ?? null, fetchCmd: fetchCmd ?? null }),
      Node.capture({}, (intake: Planned.Planned<typeof Intake.Type>) =>
        Node.bindPlanned(
          Classify.call({ items: intake.items, domains: [...domains] }),
          Node.capture({}, (classification: Planned.Planned<typeof Classification.Type>) =>
            Node.bindPlanned(
              Switchboard.child({ items: intake.items, classifications: classification.classifications }),
              Node.capture({}, (results: Planned.Planned<ReadonlyArray<HandlerResult>>) =>
                Node.bindPlanned(
                  Node.map(Node.succeed(intake.items), Node.capture({}, (normalized) => normalized.length)),
                  Node.capture(
                    {},
                    (totalItems) =>
                      Summarize.call({ classifications: classification.classifications, results, totalItems })
                  )
                ))
            ))
        ))
    ))
})

/** Every step the flow calls, and the child flow it starts. */
export const layer = Layer.mergeAll(
  IntakeStep.layer,
  Classify.layer,
  handlers.support.layer,
  handlers.sales.layer,
  handlers.security.layer,
  handlers.billing.layer,
  Summarize.layer,
  Interpreter.layer(Switchboard)
)
