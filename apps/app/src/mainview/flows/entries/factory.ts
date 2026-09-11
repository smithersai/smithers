/*
 * The `factory` flows: how a repository builds itself (Factory design
 * session 2026-09-07). One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `factory` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "factory", label: "Factory", summary: "How the repository builds itself" }

/** The `factory.*` flows registered as one aggregator block. */
export const factoryFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * Will's ruling (2026-09-07): factory.show shows the wiki stats; box
     * derivation has no UI of its own yet, so the card lists the infra-as-code
     * files and opens them. A read of the public tree, so the agent runs it
     * freely and a signed-out visitor reads a catalog repository's factory.
     */
    name: "factory.show",
    summary: "Show the repository's factory: wiki stats and the box's infra files",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.showFactory(repo)
  })
]
