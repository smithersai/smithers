/*
 * The `linear` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `linear` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "linear", label: "Linear", summary: "Linear teams and sync (ADR 0005)" }

/** The `linear` flows registered as one aggregator block. */
export const linearFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "linear.connect",
    summary: "Connect a repository to a Linear team",
    /* The wizard's Linear OAuth lands on the host's `/api/linear-auth/*` loopback, a PAT-session door. */
    runtime: ["cloud", "cloud.pat"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.linearConnect(repo)
  }),
  flow({
    /* The wizard card's step buttons — browser mechanics the human clicks. */
    name: "linear.connect.open",
    summary: "Open Linear to authorize the connection",
    hidden: true,
    runtime: ["cloud", "cloud.pat"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.linearConnectOpen(repo)
  }),
  flow({
    name: "linear.connect.team",
    summary: "Pick the Linear team for the connection",
    hidden: true,
    runtime: ["cloud", "cloud.pat"],
    args: "<teamId> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ teamId: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ teamId, repo }) => actions.linearConnectTeam(teamId, repo)
  }),
  flow({
    name: "linear.connect.repo",
    summary: "Pick the repository for the connection",
    hidden: true,
    runtime: ["cloud", "cloud.pat"],
    args: "<cardRepo> <owner/repo>",
    requires: ["signed-in"],
    input: Schema.Struct({ cardRepo: Schema.String, repo: Schema.String }),
    handler: ({ cardRepo, repo }) => actions.linearConnectRepo(cardRepo, repo)
  }),
  flow({
    name: "linear.connect.confirm",
    summary: "Create the Linear integration the wizard gathered",
    runtime: ["cloud", "cloud.pat"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.linearConnectConfirm(repo)
  }),
  flow({
    name: "linear.sync",
    summary: "Sync a Linear integration now",
    runtime: ["cloud"],
    args: "[integration]",
    requires: ["signed-in"],
    input: Schema.Struct({ integration: Schema.optional(Schema.String) }),
    handler: ({ integration }) => actions.linearSync(integration)
  }),
  flow({
    name: "linear.activity",
    summary: "Show a Linear integration's last 24 hours",
    runtime: ["cloud"],
    args: "[integration]",
    requires: ["signed-in"],
    input: Schema.Struct({ integration: Schema.optional(Schema.String) }),
    handler: ({ integration }) => actions.linearActivity(integration)
  }),
  flow({
    /* Disconnecting drops every issue's Linear link: agent invocations confirm first. */
    name: "linear.disconnect",
    form: { fields: { confirmKey: { label: "Team key, typed back" } } },
    summary: "Disconnect a Linear integration",
    runtime: ["cloud"],
    confirm: "disconnect the Linear integration",
    /* The team key typed back is the flow's own input: the seam disconnects only when it matches, whoever invoked. */
    args: "<integration> <teamKey>",
    requires: ["signed-in"],
    input: Schema.Struct({ integration: Schema.String, confirmKey: Schema.optional(Schema.String) }),
    handler: ({ integration, confirmKey }) => actions.linearDisconnect(integration, confirmKey)
  })
]
