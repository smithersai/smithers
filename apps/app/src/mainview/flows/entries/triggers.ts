/*
 * The `triggers` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `triggers` flows registered as one aggregator block. */
export const triggersFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The dispatcher card: the rules declared in .smithers/FACTORY.ts for
     * every visitor through the public mirror, and the box's live rows when a
     * signed-in session's box answers. A read, so it needs no sign-in and the
     * agent lists it freely (Factory design session 2026-09-07, mock 2).
     */
    name: "triggers.list",
    summary: "Show the dispatcher: the events the repository's rules wait for and the flows they start",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.listTriggers(repo)
  }),
  flow({
    /* The register door: a write, so sign-in is the door; it refuses honestly until a register procedure crosses the relay. */
    name: "triggers.register",
    summary: "Register a rule on the repository's box",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.registerTrigger(repo)
  })
]
