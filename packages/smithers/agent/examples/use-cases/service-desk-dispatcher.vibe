/**
 * Take in service-desk tickets, classify each as an incident, a request or a policy question, and route it to its specialist.
 *
 * Port of the 0.x `service-desk-dispatcher.jsx`. An intake agent normalizes
 * the tickets it is given, or the ones the source holds, and a classifier
 * agent labels each one with a category and an urgency. Every classified
 * ticket goes to the handler agent for its category, five at a time, and a
 * failing handler drops only its own result. A report counts the categories
 * and the handlers' outcomes.
 *
 * 0.x re-rendered its tree once the classification landed; here the handlers run in a `.child()` flow whose body plans over the real tickets.
 * 0.x's intake, classify, incident, request and policy prompts were placeholders that printed their props; these prompts state the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One normalized ticket. */
export const Ticket = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  submitter: Schema.String
})

/** What intake gathered. */
export const IntakeResult = Schema.Struct({
  tickets: Schema.Array(Ticket),
  totalReceived: Schema.Number
})

/** One ticket as the classifier labelled it. */
export const Classified = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.Literals(["incident", "request", "policy"]),
  urgency: Schema.Literals(["critical", "high", "medium", "low"]),
  reasoning: Schema.String
})

/** The classifier's answer. */
export const Classification = Schema.Struct({ classified: Schema.Array(Classified) })

/** What one handler did with its ticket. */
export const HandlerResult = Schema.Struct({
  ticketId: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["resolved", "escalated", "pending"]),
  resolution: Schema.String
})

/** The report the flow settles with. */
export const DispatchReport = Schema.Struct({
  totalTickets: Schema.Number,
  incidents: Schema.Number,
  requests: Schema.Number,
  policyQuestions: Schema.Number,
  resolved: Schema.Number,
  escalated: Schema.Number,
  pending: Schema.Number,
  summary: Schema.String
})

type Classified = typeof Classified.Type
type HandlerResult = typeof HandlerResult.Type

/** Gathers and normalizes the tickets. */
export const Intake = AgentAction.make("examples/ServiceDeskDispatcher/Intake", {
  payload: {
    source: Schema.String,
    tickets: Schema.NullOr(Schema.Array(Schema.Json)),
    fetchCmd: Schema.NullOr(Schema.String)
  },
  output: IntakeResult,
  seat,
  system: [
    `You are a service-desk intake agent. Gather and normalize incoming
tickets, ensuring each has a clear title, description, and submitter.`
  ],
  prompt: ({ fetchCmd, source, tickets }) =>
    `Gather and normalize the incoming tickets.\n\nSource: ${source}\nTickets: ${
      JSON.stringify(tickets)
    }\nFetch command: ${fetchCmd ?? "none"}`
})

/** Labels each ticket with a category and an urgency. */
export const Classify = AgentAction.make("examples/ServiceDeskDispatcher/Classify", {
  payload: { tickets: Schema.Array(Ticket) },
  output: Classification,
  seat,
  system: [
    `You are a service-desk classifier. Categorize each ticket as an incident
(something is broken or degraded), a request (someone needs something provisioned
or changed), or a policy question (someone needs guidance on rules or processes).
Assign urgency based on business impact.`
  ],
  prompt: ({ tickets }) => `Classify each ticket.\n\nTickets: ${JSON.stringify(tickets)}`
})

const handler = <const Tag extends string>(tag: Tag, system: string) =>
  AgentAction.make(tag, {
    payload: Classified,
    output: HandlerResult,
    seat,
    system: [system],
    prompt: (ticket) =>
      `Handle this ${ticket.urgency} ${ticket.category} ticket.\n\nID: ${ticket.id}\nTitle: ${ticket.title}\nReasoning: ${ticket.reasoning}`
  })

/** One specialist per category. */
export const handlers = {
  incident: handler(
    "examples/ServiceDeskDispatcher/HandleIncident",
    `You are an incident handler. Investigate the reported incident,
determine root cause where possible, apply mitigations, and escalate if the issue
requires human intervention or is beyond your tooling.`
  ),
  request: handler(
    "examples/ServiceDeskDispatcher/HandleRequest",
    `You are a service-request fulfillment agent. Process the request,
verify it meets policy, and take action to fulfill it. Escalate if approval is
needed or if the request falls outside standard procedures.`
  ),
  policy: handler(
    "examples/ServiceDeskDispatcher/HandlePolicy",
    `You are a policy advisor. Answer the submitter's question by
referencing relevant internal policies, runbooks, or documentation. Provide a
clear, actionable answer.`
  )
}

type HandlerTag = `examples/ServiceDeskDispatcher/Handle${"Incident" | "Request" | "Policy"}`

/** The specialist call for one ticket, annotated so the three specialists' calls are one node type. */
const route = (
  ticket: Classified
): Node.Node<HandlerResult, AgentAction.AgentFailure, Action.Requirement<HandlerTag>> =>
  handlers[ticket.category].call(ticket)

/**
 * Hands each classified ticket to its specialist. It runs as a child
 * execution, so its payload is real when its body plans: the routing reads
 * each ticket's `category` directly instead of branching on a planned value.
 */
export const HandleTickets = Flow.make("examples/ServiceDeskDispatcher/HandleTickets", {
  payload: { tickets: Schema.Array(Classified) },
  success: Schema.Array(HandlerResult),
  body: ({ tickets }) => {
    if (tickets.length === 0) return Node.succeed([])
    // 0.x `continueOnFail`: a failed handler settles as null instead of failing its siblings.
    const members = Object.fromEntries(tickets.map((ticket) => [
      ticket.id,
      Node.catch(route(ticket), { onFailure: () => Node.succeed(null) })
    ]))
    const joined = Bounded.all(members, { concurrency: 5 })
    return Node.map(joined, (handled) => Object.values(handled).filter(Schema.is(HandlerResult)))
  }
})

/** Counts the categories and outcomes. Pure, so it is a `Node.map`, not a step. */
const report = (
  { classified, results }: {
    readonly classified: ReadonlyArray<Classified>
    readonly results: ReadonlyArray<HandlerResult>
  }
): typeof DispatchReport.Type => {
  const category = (name: Classified["category"]) => classified.filter((t) => t.category === name).length
  const status = (name: HandlerResult["status"]) => results.filter((r) => r.status === name).length
  return {
    totalTickets: classified.length,
    incidents: category("incident"),
    requests: category("request"),
    policyQuestions: category("policy"),
    resolved: status("resolved"),
    escalated: status("escalated"),
    pending: status("pending"),
    summary: `Dispatched ${classified.length} tickets: ${category("incident")} incidents, ${
      category("request")
    } requests, ${category("policy")} policy questions — ${status("resolved")} resolved, ${
      status("escalated")
    } escalated`
  }
}

/** The flow: intake, classify, hand each ticket to its specialist, report. */
export const ServiceDeskDispatcher = Flow.make("examples/ServiceDeskDispatcher", {
  payload: {
    source: Schema.optional(Schema.String),
    tickets: Schema.optional(Schema.Array(Schema.Json)),
    fetchCmd: Schema.optional(Schema.String)
  },
  success: DispatchReport,
  error: AgentAction.AgentFailure,
  body: ({ fetchCmd, source = "service desk queue", tickets }) =>
    Node.bindPlanned(
      Intake.call({ source, tickets: tickets ?? null, fetchCmd: fetchCmd ?? null }),
      (intake: Planned.Planned<typeof IntakeResult.Type>) =>
        Node.bindPlanned(
          Classify.call({ tickets: intake.tickets }),
          (classification: Planned.Planned<typeof Classification.Type>) =>
            Node.bindPlanned(
              HandleTickets.child({ tickets: classification.classified }),
              (results: Planned.Planned<ReadonlyArray<HandlerResult>>) =>
                Node.map(Node.succeed({ classified: classification.classified, results }), report)
            )
        )
    )
})

/** Every step the flow calls, and the child flow it starts. */
export const layer = Layer.mergeAll(
  Intake.layer,
  Classify.layer,
  handlers.incident.layer,
  handlers.request.layer,
  handlers.policy.layer,
  Interpreter.layer(HandleTickets)
)
