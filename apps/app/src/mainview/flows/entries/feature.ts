/*
 * The `feature` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `feature` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "feature", label: "Feature requests", summary: "Prototype a feature request against a repository" }

/** The `feature` flows registered as one aggregator block. */
export const featureFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * A run of kind prototype (Factory design session 2026-09-07 §6b): the
     * workspace's `prototype` flow on the request, tracked by the run card
     * as a trace. Fast and cheap exploration only; never promoted. Signed out,
     * the controller's gate parks a human's invocation on the auth.prompt step
     * (the same door repo.contribute renders) and refuses the model's.
     */
    name: "feature.prototype",
    form: {
      fields: {
        request: { label: "What should it do?" },
        repo: { optionsFrom: "cloud-repos", kind: "text" }
      }
    },
    summary: "Prototype a feature request as a run: exploration only, never promoted",
    runtime: ["cloud"],
    args: "<what it should do> [owner/repo]",
    capabilities: ["outbound:launch"],
    input: Schema.Struct({ request: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ request, repo }) => actions.prototypeFeature(request, repo)
  })
]
