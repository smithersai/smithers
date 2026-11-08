/**
 * Classify a batch of items, then route each actionable one to its handler.
 *
 * Port of the 0.x `triage.jsx`. A classifier agent assigns every item a
 * category, a priority and a route. Each item not routed to `ignore` goes to
 * the handler agent for its route, five at a time, and a failing handler drops
 * only its own result. A report counts the outcomes.
 *
 * 0.x re-rendered its tree once the classification landed; here the handlers run in a `.child()` flow whose body plans over the real items.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One classified item and the handler it is routed to. */
export const Item = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.String,
  priority: Schema.Literals(["urgent", "high", "medium", "low"]),
  assignTo: Schema.Literals(["security", "bug-fix", "feature", "docs", "infra", "ignore"]),
  reasoning: Schema.String
})

/** The classifier's answer. */
export const Classification = Schema.Struct({ items: Schema.Array(Item) })

/** What one handler did with its item. */
export const HandlerResult = Schema.Struct({
  itemId: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["handled", "escalated", "deferred"]),
  summary: Schema.String
})

/** The report the flow settles with. `byCategory` counts items per route. */
export const TriageReport = Schema.Struct({
  totalItems: Schema.Number,
  handled: Schema.Number,
  escalated: Schema.Number,
  deferred: Schema.Number,
  byCategory: Schema.Record(Schema.String, Schema.Number),
  summary: Schema.String
})

type Item = typeof Item.Type
type HandlerResult = typeof HandlerResult.Type

/** Classifies the batch it is given, or the one `fetchCmd` lists. */
export const Classify = AgentAction.make("examples/Triage/Classify", {
  payload: { source: Schema.String, items: Schema.NullOr(Schema.Array(Schema.Json)), fetchCmd: Schema.String },
  output: Classification,
  seat,
  system: [
    `You are a triage specialist. Classify incoming items by category,
priority, and routing. Be consistent and fair in prioritization.
Use "ignore" for items that don't need action.`
  ],
  prompt: ({ fetchCmd, items, source }) =>
    `Triage these items:\n\nSource: ${source}\n${
      items === null ? `Command to fetch items: ${fetchCmd}` : `Items:\n${JSON.stringify(items, null, 2)}`
    }\n\nClassify each by category, priority, and routing.`
})

const handler = <const Tag extends string>(tag: Tag, role: string) =>
  AgentAction.make(tag, {
    payload: Item,
    output: HandlerResult,
    seat,
    system: [
      `You are a ${role} handler. Take appropriate action on the assigned item.
If you can handle it, do so. If it needs human attention, escalate with details.`
    ],
    prompt: (item) =>
      `Handle this ${item.priority} ${item.category} item:\n\nID: ${item.id}\nTitle: ${item.title}\nRouting: ${item.assignTo}\nReasoning: ${item.reasoning}\n\nTake appropriate action or escalate with details.`
  })

/** One handler per route. `ignore` has none. */
export const handlers = {
  security: handler("examples/Triage/HandleSecurity", "security incident"),
  "bug-fix": handler("examples/Triage/HandleBugFix", "bug fix"),
  feature: handler("examples/Triage/HandleFeature", "feature request"),
  docs: handler("examples/Triage/HandleDocs", "documentation"),
  infra: handler("examples/Triage/HandleInfra", "infrastructure")
}

type Actionable = Item & { readonly assignTo: keyof typeof handlers }

type HandlerTag = `examples/Triage/Handle${"Security" | "BugFix" | "Feature" | "Docs" | "Infra"}`

/** The handler call for one item, annotated so the five handlers' calls are one node type. */
const route = (item: Actionable): Node.Node<HandlerResult, AgentAction.AgentFailure, Action.Requirement<HandlerTag>> =>
  handlers[item.assignTo].call(item)

/**
 * Handles the classified items. It runs as a child execution, so its payload
 * is real when its body plans: the routing below reads each item's `assignTo`
 * directly instead of branching on a planned value.
 */
export const HandleItems = Flow.make("examples/Triage/HandleItems", {
  payload: { items: Schema.Array(Item) },
  success: Schema.Array(HandlerResult),
  body: ({ items }) => {
    const actionable = items.filter((item): item is Actionable => item.assignTo !== "ignore")
    if (actionable.length === 0) return Node.succeed([])
    // 0.x `continueOnFail`: a failed handler settles as null instead of failing its siblings.
    const members = Object.fromEntries(actionable.map((item) => [
      item.id,
      Node.catch(route(item), { onFailure: () => Node.succeed(null) })
    ]))
    const joined = Bounded.all(members, { concurrency: 5 })
    return Node.map(joined, (handled) => Object.values(handled).filter(Schema.is(HandlerResult)))
  }
})

/** Counts the outcomes. Pure, so it is a `Node.map`, not a step. */
const report = (
  { items, results }: { readonly items: ReadonlyArray<Item>; readonly results: ReadonlyArray<HandlerResult> }
): typeof TriageReport.Type => {
  const count = (status: HandlerResult["status"]) => results.filter((r) => r.status === status).length
  const byCategory: Record<string, number> = {}
  for (const item of items) byCategory[item.assignTo] = (byCategory[item.assignTo] ?? 0) + 1
  return {
    totalItems: items.length,
    handled: count("handled"),
    escalated: count("escalated"),
    deferred: count("deferred"),
    byCategory,
    summary: `Triaged ${items.length} items: ${count("handled")} handled, ${count("escalated")} escalated`
  }
}

/** The flow: classify, handle the actionable items, report. */
export const Triage = Flow.make("examples/Triage", {
  payload: {
    source: Schema.optional(Schema.String),
    items: Schema.optional(Schema.Array(Schema.Json)),
    fetchCmd: Schema.optional(Schema.String)
  },
  success: TriageReport,
  error: AgentAction.AgentFailure,
  body: ({ fetchCmd = "gh issue list --json number,title,body,labels --limit 20", items, source = "GitHub issues" }) =>
    Node.bindPlanned(
      Classify.call({ source, items: items ?? null, fetchCmd }),
      (classification: Planned.Planned<typeof Classification.Type>) =>
        Node.bindPlanned(
          HandleItems.child({ items: classification.items }),
          (results: Planned.Planned<ReadonlyArray<HandlerResult>>) =>
            Node.map(Node.succeed({ items: classification.items, results }), report)
        )
    )
})

/** Every step the flow calls, and the child flow it starts. */
export const layer = Layer.mergeAll(
  Classify.layer,
  handlers.security.layer,
  handlers["bug-fix"].layer,
  handlers.feature.layer,
  handlers.docs.layer,
  handlers.infra.layer,
  Interpreter.layer(HandleItems)
)
