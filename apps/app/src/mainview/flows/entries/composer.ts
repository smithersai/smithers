/*
 * The `composer` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `composer` flows registered as one aggregator block. */
export const composerFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* The composer's `+`: add files, a connector, a flow, an agent. */
    name: "composer.add",
    summary: "Open the composer's add menu",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opening the composer's menu is the human's gesture",
    input: NoPayload,
    handler: () => actions.toggleAddMenu()
  })
]
