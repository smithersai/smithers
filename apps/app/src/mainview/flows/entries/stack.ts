/*
 * The `stack` flows: the repository's mythical stack (epic #1745), served by
 * `@smthrs/rpc/Mythical`. `stack.show` embeds the live Stack card; backfill,
 * lane count and retry are the admin writes the API has, each acknowledged
 * at once and finished in the shared toast stack. Creating the stack is
 * `history.bootstrap`. One module per namespace: Flows.ts registers the block.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `stack` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "stack", label: "Stack", summary: "The mythical stack" }

const RepoOptional = Schema.optional(Schema.String)

/** The `stack` flows registered as one aggregator block. */
export const stackFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "stack.show",
    summary: "Show the mythical stack: every issue, its lane, checks and pull request",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.showStack(repo)
  }),
  flow({
    name: "stack.backfill",
    summary: "Admit every open issue to the mythical stack now",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    confirm: "admit every open issue to the stack",
    input: RepoTarget,
    handler: ({ repo }) => actions.backfillStack(repo)
  }),
  flow({
    name: "stack.parallel",
    summary: "Set how many lanes work at once",
    runtime: ["cloud"],
    args: "<1-8> [owner/repo]",
    requires: ["signed-in"],
    confirm: "change how many lanes work at once",
    input: Schema.Struct({ value: Schema.Number, repo: RepoOptional }),
    handler: ({ value, repo }) => actions.setStackParallel(value, repo)
  }),
  flow({
    name: "stack.retry",
    summary: "Give a blocked, rejected or declined issue a fresh set of attempts",
    runtime: ["cloud"],
    args: "<item> [owner/repo]",
    requires: ["signed-in"],
    confirm: "retry this issue on the stack",
    input: Schema.Struct({ id: Schema.String, repo: RepoOptional }),
    handler: ({ id, repo }) => actions.retryStackItem(id, repo)
  })
]
