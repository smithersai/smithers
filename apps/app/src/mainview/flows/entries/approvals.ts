/*
 * The `approvals` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `approvals` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "approvals", label: "Run approvals", summary: "The workspace's pending gates" }

/** The `approvals` flows registered as one aggregator block. */
export const approvalsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "approvals.list",
    summary: "List the workspace's pending approvals",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ repo: Schema.optional(Schema.String) }),
    handler: ({ repo }) => actions.listApprovals(repo)
  }),
  flow({
    name: "approvals.open",
    summary: "Open a run's pending approvals as cards",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, sourceCard: Schema.optional(Schema.String) }),
    handler: ({ runId, sourceCard }) => actions.openApproval(runId, sourceCard)
  })
]
