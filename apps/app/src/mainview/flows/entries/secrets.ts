/*
 * The `secrets` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `secrets` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "secrets", label: "Secrets", summary: "Secrets a repository's sessions may use" }

/** The `secrets` flows registered as one aggregator block. */
export const secretsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "secrets.list",
    summary: "Show the secrets a repository's sessions may use: names and bindings, never values",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listSecrets(repo)
  })
]
