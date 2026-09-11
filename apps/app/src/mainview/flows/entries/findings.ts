/*
 * The `findings` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `findings` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "findings", label: "Findings", summary: "What the analyzers raised on a change (ADR 0004)" }

/** The `findings` flows registered as one aggregator block. */
export const findingsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "findings.please-fix",
    summary: "Dispatch the agent on one finding",
    runtime: ["cloud"],
    confirm: "dispatch the agent on the finding",
    args: "<changeId> <findingId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, findingId: Schema.Number }),
    handler: ({ changeId, findingId }) => actions.fixFinding(changeId, findingId)
  }),
  flow({
    name: "findings.not-useful",
    summary: "Mark a finding not useful",
    runtime: ["cloud"],
    args: "<changeId> <findingId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, findingId: Schema.Number }),
    handler: ({ changeId, findingId }) => actions.findingNotUseful(changeId, findingId)
  })
]
