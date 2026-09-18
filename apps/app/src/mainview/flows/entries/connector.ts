/*
 * The `connector` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"
import type { CommandActions } from "./Declare"

/** The `connector` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "connector", label: "Connectors", summary: "Local repository connections" }

/** Connect leads world until something is connected. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "connect", when: () => true, rank: (state) => (state.hasConnectors ? 2 : 1) }
]

/** The bare `connect` surface switch, registered first with the other top-level surfaces. */
export const connectSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "connect",
    summary: "Connect work to Smithers",
    input: NoPayload,
    handler: () => actions.showConnectors()
  })
]
