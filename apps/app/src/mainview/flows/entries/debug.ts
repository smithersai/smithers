/*
 * The `debug` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `debug` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "debug", label: "Debug", summary: "Observability and dev tooling" }

/** `debug.verbose`, the one debug flow every session registers. */
export const debugVerboseFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /*
   * The maintainer's switch: every flow invocation (hidden, aliased,
   * agent-driven, deferred) and every background or system transition
   * renders as a trace line, and the transition logger writes to the
   * console. Registered for every session rather than the admin plugin:
   * the local host has no identity seam, so an admin gate would make the
   * switch unreachable exactly where the maintainer runs the app.
   */
  const VERBOSE = {
    name: "debug.verbose",
    summary: "Show everything Smithers is doing",
    input: NoPayload,
    handler: () => actions.toggleVerbose()
  }
  return [
  flow(VERBOSE)
  ]
}

/** The `debug.*` admin flows. */
export const debugFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * DESIGN.md §14: report what drives a turn. A read, not a switch — there
     * is one backend, and an argument asking for another is answered rather
     * than ignored. user-only: the agent must never reason about its engine.
     */
    name: "debug.backend",
    summary: "Report the agent backend",
    userOnly: true,
    userOnlyReason: "admin diagnostics; the agent must never reason about its engine",
    input: Schema.Struct({ backend: Schema.String }),
    handler: ({ backend }) => actions.describeAgentBackend(backend)
  }),
  flow({
    /* The debug reads — one typed surface the panel AND the agent share. */
    name: "debug.snapshot",
    summary: "Read the app state snapshot",
    input: NoPayload,
    handler: () => actions.debugSnapshot()
  }),
  flow({
    name: "debug.events",
    summary: "Read the transition journal tail",
    input: NoPayload,
    handler: () => actions.debugEvents()
  }),
  flow({
    /* Debug mode's chain x-ray (§14): the journal fold, as data. */
    name: "debug.chain",
    summary: "Read the chain journal x-ray",
    input: NoPayload,
    handler: () => actions.debugChain()
  }),
  flow({
    /* Debug mode's wire tap (§14): the controller's fetch ring. */
    name: "debug.net",
    summary: "Read the network tap",
    input: NoPayload,
    handler: () => actions.debugNet()
  }),
  flow({
    /* The session tier's revocation (§14): drop every chain grant. */
    name: "debug.grants.reset",
    summary: "Revoke the chain's session grants",
    userOnly: true,
    userOnlyReason: "revokes the chain's own session grants; the operator's act",
    input: NoPayload,
    handler: () => actions.resetGrants()
  }),
  flow({
    name: "debug.seams",
    summary: "Probe seam and upstream health",
    input: NoPayload,
    handler: () => actions.debugSeams()
  })
]
