/*
 * The `target` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { line, text } from "../FlowForms"
import { flow, TargetRef } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `target` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "target", label: "Targets", summary: "Build targets, runs, graph, CI" }

/** The `target` flows registered as one aggregator block. */
export const targetFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /* The target-card runs: builds and tests on the human's machine, so the agent asks and the human confirms. */
  flow({
    name: "target.run",
    form: {
      fields: { repoId: { optionsFrom: "open-repos" }, label: { label: "Target label" } },
      args: (payload) => line(text(payload, "repoId"), text(payload, "workspace"), text(payload, "label"))
    },
    summary: "Run a Smithers target",
    runtime: ["local.targets"],
    confirm: "run the Smithers target",
    args: "<repoId> [workspace] <label>",
    input: TargetRef,
    handler: ({ repoId, label, workspace }) => actions.runTarget(repoId, workspace ?? ".", label)
  }),
  flow({
    name: "target.run.pattern",
    form: {
      fields: { repoId: { optionsFrom: "open-repos" } },
      args: (payload) => line(text(payload, "repoId"), text(payload, "workspace"), text(payload, "verb"), text(payload, "pattern"))
    },
    summary: "Run a Smithers verb over a pattern (`ci //packages/...`)",
    runtime: ["local.targets"],
    confirm: "run the Smithers verb over the pattern",
    args: "<repoId> [workspace] <verb> <pattern>",
    input: Schema.Struct({
      repoId: Schema.String,
      verb: Schema.String,
      pattern: Schema.String,
      workspace: Schema.optional(Schema.String)
    }),
    handler: ({ repoId, workspace, verb, pattern }) => actions.runPattern(repoId, workspace ?? ".", verb, pattern)
  }),
  flow({
    /* Showing a target is how the agent answers "show me //src:lint" too. */
    name: "target.open",
    form: {
      fields: { repoId: { optionsFrom: "open-repos" }, label: { label: "Target label" } },
      args: (payload) => line(text(payload, "repoId"), text(payload, "workspace"), text(payload, "label"))
    },
    summary: "Show a Smithers target in its targets card",
    runtime: ["local.targets"],
    args: "<repoId> <label>",
    input: TargetRef,
    handler: ({ repoId, label }) => actions.openTarget(repoId, label)
  }),
  /*
   * The targets table (docs/LOCAL-APP.md "Cards"): its filter chips and text,
   * and the row whose drawer is open. Both are the card's own affordances;
   * the state they change lives in the card payload, never in a component.
   */
  flow({
    name: "target.filter",
    summary: "Filter the targets table",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the targets table's filter is the human's control; the agent lists targets with target.list",
    args: "<repoId> [mode=<featured|all|recent>] [query=<text>] [kind=<kind>] [state=<never|passed|failed|running>] [workspace=<path>]",
    input: Schema.Struct({
      repoId: Schema.String,
      mode: Schema.optional(Schema.String),
      query: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String)
    }),
    handler: ({ repoId, mode, query, kind, state, workspace }) =>
      actions.filterTargets(repoId, {
        ...(mode === undefined ? {} : { mode }),
        ...(query === undefined ? {} : { query }),
        ...(kind === undefined ? {} : { kind }),
        ...(state === undefined ? {} : { state }),
        ...(workspace === undefined ? {} : { workspace })
      })
  }),
  flow({
    name: "target.select",
    summary: "Open a target's details in the targets table, or close them",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the targets table's row drawer is the human's control; the agent shows a target with target.open",
    args: "<repoId> [label]",
    input: Schema.Struct({ repoId: Schema.String, label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.selectTarget(repoId, label)
  }),
  /*
   * The user's stars: the Featured view leads with the manifest's featured
   * labels and these. Persisted by repository path (app-starred-targets), so
   * a star outlives the server's fresh repo id on a reopen.
   */
  flow({
    name: "target.star",
    summary: "Star a target so it leads the targets table's Featured view",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "starring is the human's own ranking of the table",
    args: "<repoId> <label>",
    input: Schema.Struct({ repoId: Schema.String, label: Schema.String }),
    handler: ({ repoId, label }) => actions.starTarget(repoId, label, true)
  }),
  flow({
    name: "target.unstar",
    summary: "Take a star back from a target",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "starring is the human's own ranking of the table",
    args: "<repoId> <label>",
    input: Schema.Struct({ repoId: Schema.String, label: Schema.String }),
    handler: ({ repoId, label }) => actions.starTarget(repoId, label, false)
  }),
  /*
   * Name groups (cards/TargetsTable.ts groupRows): targets sharing a name
   * across packages read as one `//...:name` row. The build CLI has no
   * `:name` wildcard, so "run the set" is one target.run per picked member.
   */
  flow({
    name: "target.expand",
    summary: "Expand or collapse a grouped row in the targets table",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the targets table's grouped rows are the human's control",
    args: "<repoId> <//...:name>",
    input: Schema.Struct({ repoId: Schema.String, group: Schema.String }),
    handler: ({ repoId, group }) => actions.expandTargetGroup(repoId, group)
  }),
  flow({
    name: "target.pick",
    summary: "Pick which members of a grouped row run (a label toggles; all / none)",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "picking a grouped row's members is the human's control",
    args: "<repoId> <//...:name> <label|all|none>",
    input: Schema.Struct({ repoId: Schema.String, group: Schema.String, member: Schema.String }),
    handler: ({ repoId, group, member }) => actions.pickTargets(repoId, group, member)
  }),
  flow({
    name: "target.run.set",
    summary: "Run every picked member of a grouped row",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "runs the members the human picked in the table; the agent runs a target by label with target.run",
    args: "<repoId> <//...:name>",
    input: Schema.Struct({ repoId: Schema.String, group: Schema.String }),
    handler: ({ repoId, group }) => actions.runTargetSet(repoId, group)
  }),
  /*
   * The target-graph cards (docs/LOCAL-APP.md "Cards: target graph"): "show
   * graph" / "graph //src:lint" opens the typed DAG (focused when a label is
   * named), "timeline"/"history" the run views (a history row replays into
   * both the timeline and the graph overlay), "affected" the diff set, "show
   * ci" the generated matrix. The repo id may go unnamed when exactly one
   * repository is open — the controller resolves it.
   */
  flow({
    /*
     * The targets table on request: opening a repository renders nothing,
     * so the table is this explicit act (a bare call means the active repo).
     */
    name: "target.list",
    summary: "List the repository's Smithers targets",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.listTargets(repoId)
  }),
  flow({
    name: "target.graph",
    summary: "Show the target graph",
    runtime: ["local.targets"],
    args: "[repoId] [label]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.showGraph(repoId, label)
  }),
  flow({
    /* The graph drawer's focus: pin one label, or clear the focus when none is named. */
    name: "target.graph.focus",
    summary: "Focus the target graph on one label, or clear the focus details",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the graph drawer's own selection; the agent opens the graph focused with target.graph [label]",
    args: "<repoId> [label]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.focusGraphNode(repoId, label)
  }),
  flow({
    /* The canvas toolbar: the label filter and the private-node toggle, both card payload state. */
    name: "target.graph.filter",
    summary: "Filter the target graph's labels, or show its private helpers",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the graph canvas' own toolbar; the agent opens the graph focused with target.graph [label]",
    args: "<repoId> [query=<text>] [private=<on|off>]",
    input: Schema.Struct({
      repoId: Schema.optional(Schema.String),
      query: Schema.optional(Schema.String),
      private: Schema.optional(Schema.Literals(["on", "off"]))
    }),
    handler: ({ repoId, query, private: showPrivate }) =>
      actions.filterGraph(repoId, {
        ...(query === undefined ? {} : { query }),
        ...(showPrivate === undefined ? {} : { showPrivate: showPrivate === "on" })
      })
  }),
  flow({
    name: "target.timeline",
    summary: "Show one target run's timeline",
    runtime: ["local.targets"],
    args: "[repoId] <runId>",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), runId: Schema.optional(Schema.String) }),
    handler: ({ repoId, runId }) => actions.showRunTimeline(repoId, runId)
  }),
  flow({
    name: "target.history",
    summary: "Show the repository's target run history",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showRunHistory(repoId)
  }),
  flow({
    name: "target.runs.select",
    form: { args: (payload) => line(text(payload, "repoId"), text(payload, "runId")) },
    summary: "Replay a recorded run into the timeline and the graph",
    runtime: ["local.targets"],
    hidden: true,
    args: "[repoId] <runId>",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ repoId, runId }) => actions.selectRunReplay(repoId, runId)
  }),
  flow({
    /* The replay scrubber: the slider's own act (time travel), user-triggered only. */
    name: "target.run.scrub",
    summary: "Replay a recorded run up to a cursor",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the replay slider is the human's gesture (time travel)",
    args: "<runId> <cursor>",
    input: Schema.Struct({ runId: Schema.String, cursor: Schema.Number }),
    handler: ({ runId, cursor }) => actions.scrubRunReplay(runId, cursor)
  }),
  flow({
    name: "target.affected",
    summary: "Show what the working-tree diff affects",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showAffected(repoId)
  }),
  flow({
    name: "target.ci",
    summary: "Show the CI matrix the target graph implies",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showCiMatrix(repoId)
  }),
  flow({
    /* The graph drawer's "open" affordance for a declaration site. */
    name: "target.source.open",
    summary: "Open a target's declaration source",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "opens the declaration in the human's editor — a handoff off the app",
    args: "<repoId> <file[:line]>",
    input: Schema.Struct({ repoId: Schema.String, file: Schema.String }),
    handler: ({ repoId, file }) => {
      const split = /^(.*):(\d+)$/.exec(file)
      return split === null
        ? actions.openTargetSource(repoId, file)
        : actions.openTargetSource(repoId, split[1] ?? file, Number(split[2]))
    }
  })
]
