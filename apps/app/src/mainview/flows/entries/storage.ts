/*
 * The `storage` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { storageRecoveryExportFlow } from "../StorageRecoveryFlow"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `storage` flows registered as one aggregator block. */
export const storageFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "storage.recovery",
    summary: "Offer a private local recovery download in the chat",
    input: NoPayload,
    handler: () => actions.promptStorageRecovery()
  }),
  storageRecoveryExportFlow(actions.exportStorageRecovery)
]
