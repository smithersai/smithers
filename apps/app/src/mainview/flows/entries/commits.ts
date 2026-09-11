/*
 * The `commits` flows: a branch's history and one commit. One module per
 * namespace: a lane that adds or edits a flow here touches no other flow
 * module, and Flows.ts registers each block in the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `commits` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "commits", label: "Commits", summary: "Repository commit history" }

/** `commits.list` and `commits.read`. */
export const commitsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* A lone token with a slash is the repository (deterministic, like files.*); name both to list a slashed branch. */
    name: "commits.list",
    summary: "List a branch's commits, newest first",
    /* The practice repository (state/practice) answers without the cloud; its key also skips the sign-in gate. */
    runtimeAny: ["cloud", "practice"],
    args: "[branch] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ branch: Schema.optional(Schema.String), repo: Schema.optional(Schema.String) }),
    handler: ({ branch, repo }) => actions.listCommits(branch, repo)
  }),
  flow({
    name: "commits.read",
    summary: "Show one commit: its message, parents and diff",
    /* The practice repository (state/practice) answers without the cloud; its key also skips the sign-in gate. */
    runtimeAny: ["cloud", "practice"],
    args: "<change-id> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ ref: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ ref, repo }) => actions.readCommit(ref, repo)
  })
]
