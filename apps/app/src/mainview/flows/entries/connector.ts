/*
 * The `connector` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { type RepositoryAccess } from "@smthrs/rpc/NativeRepository"
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

/** The `connector.*` flows: local repository connections. */
export const connectorFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "connector.add",
    summary: "Connect a local repository",
    runtime: ["local.repositories"],
    hidden: true,
    args: "<read|read-write>",
    input: Schema.Struct({ access: Schema.Literals(["read", "read-write"]) }),
    handler: async ({ access }) => {
      await actions.connectLocalRepository(access as RepositoryAccess)
    }
  }),
  flow({
    name: "connector.downgrade",
    summary: "Make a connector read-only",
    runtime: ["local.repositories"],
    hidden: true,
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => actions.makeConnectorReadOnly(connectorId)
  }),
  flow({
    name: "connector.remove.ask",
    summary: "Ask before disconnecting a repository",
    runtime: ["local.repositories"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "opens the human's confirm dialog; the act itself is connector.remove",
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => actions.askConnectorRemoval(connectorId)
  }),
  flow({
    name: "connector.remove",
    summary: "Disconnect a repository",
    runtime: ["local.repositories"],
    hidden: true,
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => actions.removeConnector(connectorId)
  }),
  flow({
    name: "connector.remove.cancel",
    summary: "Keep a connected repository",
    runtime: ["local.repositories"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelConnectorRemoval()
  })
]
