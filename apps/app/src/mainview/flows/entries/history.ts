/*
 * The `history` flows: the mythical history (Factory design session
 * 2026-09-07 §3, mock 13). history.show is the read every visitor gets
 * through the public mirror seam; bootstrap, amend and fold are the write
 * doors: registered with their three doors and signed-in, and refusing with
 * the empty state's own sentence until the retell flow exists. One module per
 * namespace: Flows.ts registers the block in the aggregator order.
 */
import { Schema } from "effect"
import type { LibrarianRunsController } from "../../state/controller/librarianRuns"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `history` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "history", label: "History", summary: "The mythical history and its notes" }

/** The `history` flows registered as one aggregator block. */
export const historyFlows = (actions: CommandActions & Partial<LibrarianRunsController>): ReadonlyArray<FlowEntry> => [
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
    summary: "Create Mythical history in the background",
    args: "<owner/repo>",
    requires: ["signed-in"],
    capabilities: ["outbound:launch"],
    confirm: "create the repository mythical history",
    input: Schema.Struct({ repo: Schema.NonEmptyString }),
    /* Typed owner/repo, with the loaded repositories offered: the grammar reads only that shape. */
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text", label: "Repository" } } },
    handler: ({ repo }) => actions.bootstrapHistory?.(repo) ?? "Create Mythical history is unavailable on this host."
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
