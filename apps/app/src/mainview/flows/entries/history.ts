/*
 * The `history` flows: the mythical history (Factory design session
 * 2026-09-07 §3, mock 13). history.show is the read every visitor gets
 * through the public mirror seam; bootstrap, amend and fold are the write
 * doors: registered with their three doors and signed-in. Bootstrap asks the
 * server to create the stack (`@smthrs/rpc/Mythical`); amend and fold refuse
 * with the empty state's own sentence until the retell flow exists. One module per
 * namespace: Flows.ts registers the block in the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `history` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "history", label: "History", summary: "The mythical history and its notes" }

/** The `history` flows registered as one aggregator block. */
export const historyFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "history.show",
    summary: "Show the mythical history: epics, their atomic commits, the notes, and the tree-equality badge",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    prepare: ({ repo }) => actions.showHistory.preload?.(repo),
    handler: ({ repo }) => actions.showHistory(repo)
  }),
  flow({
    name: "history.bootstrap",
    summary: "Create the mythical stack from main's history",
    runtime: ["cloud"],
    args: "<owner/repo>",
    requires: ["signed-in"],
    confirm: "create the repository mythical history",
    input: Schema.Struct({ repo: Schema.NonEmptyString }),
    /* Typed owner/repo, with the loaded repositories offered: the grammar reads only that shape. */
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text", label: "Repository" } } },
    /* The server's stack (#1760): acknowledged at once, its notice runs until the stack reads active. */
    handler: ({ repo }) => actions.bootstrapStack(repo)
  }),
  flow({
    name: "history.amend",
    summary: "Amend a mythical commit and rebase the commits after it",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.retellHistory("amend", repo)
  }),
  flow({
    name: "history.fold",
    summary: "Fold the default bookmark's outside merges into the mythical history",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.retellHistory("fold", repo)
  })
]
