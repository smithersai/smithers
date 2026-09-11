/*
 * The `github` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `github` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "github", label: "GitHub", summary: "The GitHub App and the mirror (ADR 0005)" }

/** The `github` flows registered as one aggregator block. */
export const githubFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Lane sync (ADR 0005): Linear and GitHub sync as actions. The reads
   * render the connector-setup and sync-ops cards; the writes ride the same
   * seams. Every route these acts call exists on plue's own router; a server
   * that has not deployed one answers, and the seam surfaces that answer.
   */
  flow({
    name: "github.app",
    summary: "Check the Smithers GitHub App on a repository",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubApp(repo)
  }),
  flow({
    /* The card's Install button — browser mechanics the human clicks. */
    name: "github.app.open",
    summary: "Open the GitHub App's install page",
    hidden: true,
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubOpenInstall(repo)
  }),
  flow({
    name: "github.reconcile",
    summary: "Re-derive the GitHub App's wiring, then re-read the status",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubReconcile(repo)
  }),
  flow({
    name: "github.mirror-sync",
    summary: "Pull GitHub into the repository's mirror",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubMirrorSync(repo)
  }),
  flow({
    /*
     * plue#491: one failed ref, pushed again. The ref name carries slashes
     * and rides as one escaped path segment; the answer is a new mirror run,
     * which the same card then tracks.
     */
    name: "github.mirror.retry-ref",
    summary: "Retry one failed mirror ref",
    runtime: ["cloud"],
    args: "<ref> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ ref: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ ref, repo }) => actions.retryMirrorRef(ref, repo)
  })
]
