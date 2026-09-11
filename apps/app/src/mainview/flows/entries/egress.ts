/*
 * The `egress` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `egress` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "egress", label: "Egress", summary: "What a computer or an agent session called out to" }

/** The `egress` flows registered as one aggregator block. */
export const egressFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* The same audit for an agent session's sandbox; the app has no agent-session card to face it. */
    name: "egress.session",
    summary: "List what an agent session called out to, and which secret names were swapped in",
    runtime: ["cloud"],
    args: "<sessionId> [owner/repo] [cursor]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sessionId: Schema.String,
      repo: Schema.optional(Schema.String),
      cursor: Schema.optional(Schema.String)
    }),
    handler: ({ sessionId, repo, cursor }) => actions.listSessionEgress(sessionId, repo, cursor)
  })
]
