/*
 * The `system` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `system` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "system", label: "System", summary: "Background flows" }

/** The `system` flows registered as one aggregator block. */
export const systemFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The next-step recommender (state/Recommend.ts): system-invoked after
     * every material transition, never listed, never the model's to call —
     * a model must not steer what the human is offered next.
     */
    name: "system.recommend",
    summary: "Refresh the next-step suggestions",
    hidden: true,
    userOnly: true,
    userOnlyReason: "the system's own refresh; a model must not steer what the human is offered next",
    input: NoPayload,
    handler: () => actions.recommend()
  })
]
