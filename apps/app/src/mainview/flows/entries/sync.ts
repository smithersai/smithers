/*
 * The `sync` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `sync` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "sync", label: "Sync", summary: "Sync ops and retries (ADR 0005)" }

/** The `sync` flows registered as one aggregator block. */
export const syncFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "sync.retry",
    summary: "Retry one failed sync op",
    runtime: ["cloud"],
    args: "<opId>",
    requires: ["signed-in"],
    input: Schema.Struct({ opId: Schema.String }),
    handler: ({ opId }) => actions.retrySyncOp(opId)
  }),
  flow({
    /* The sync-ops card's Show more — browser mechanics the human clicks. */
    name: "sync.ops.show-more",
    summary: "Widen a sync card's ops window",
    hidden: true,
    runtime: ["cloud"],
    args: "<cardId>",
    requires: ["signed-in"],
    input: Schema.Struct({ cardId: Schema.String }),
    handler: ({ cardId }) => actions.showMoreSyncOps(cardId)
  }),
  flow({
    /* The sync-ops card's Load older — pages the feed past the 24-hour window. */
    name: "sync.ops.load-older",
    summary: "Load a sync card's older ops",
    hidden: true,
    runtime: ["cloud"],
    args: "<cardId>",
    requires: ["signed-in"],
    input: Schema.Struct({ cardId: Schema.String }),
    handler: ({ cardId }) => actions.loadOlderSyncOps(cardId)
  })
]
