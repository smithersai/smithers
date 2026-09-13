/*
 * The `runs` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { line, text } from "../FlowForms"
import type { FlowEntry, Namespace } from "../registry"
import { flow } from "./Declare"
import type { CommandActions } from "./Declare"

/** The `runs` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = {
  id: "runs",
  label: "Runs",
  summary: "The runs on your workspace: open, resume, steer, stop"
}

/** The `runs` flows registered as one aggregator block. */
export const runsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Lane runs — the run lifecycle beyond launch.
   *
   * The inbox (runs.list) answers from the workspace-runs projection; every
   * act is a control procedure over the gateway seam. What the wire does not
   * carry, the flow refuses in words: `by=` names a launcher the run summary
   * does not record, so it is a refusal, never a silently dropped filter.
   */
  flow({
    name: "runs.list",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) =>
        line(
          text(payload, "status"),
          text(payload, "flow"),
          text(payload, "by") === undefined ? undefined : `by=${text(payload, "by")}`,
          text(payload, "lineage") === undefined ? undefined : `lineage=${text(payload, "lineage")}`,
          text(payload, "sourceCard") === undefined ? undefined : `sourceCard=${text(payload, "sourceCard")}`,
          text(payload, "repo")
        )
    },
    summary: "List the runs on your workspace",
    runtime: ["cloud"],
    args: "[status] [flow] [by=principal] [lineage=id] [sourceCard=id] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      status: Schema.optional(Schema.String),
      flow: Schema.optional(Schema.String),
      lineage: Schema.optional(Schema.String),
      by: Schema.optional(Schema.String),
      sourceCard: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: (payload) => actions.listRuns(payload)
  }),
  flow({
    name: "runs.open",
    summary: "Open a run as a card that tracks it",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ runId, repo, sourceCard }) => actions.openRun(runId, repo, sourceCard)
  }),
  flow({
    name: "runs.resume",
    confirm: "resume the run",
    summary: "Resume a parked run",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.resumeRun(runId, sourceCard)
  }),
  flow({
    /* A relaunch is real work on the user's workspace: the launch capability. */
    name: "runs.rerun",
    summary: "Run a run's flow again with the same input",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.rerunRun(runId, sourceCard)
  }),
  flow({
    name: "runs.signal",
    confirm: "release the run's wait with a signal",
    summary: "Deliver a named signal to a waiting run",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <name> [json]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      name: Schema.String,
      payload: Schema.optional(Schema.String)
    }),
    handler: ({ runId, name, payload, sourceCard }) => actions.signalRun(runId, name, payload, sourceCard)
  }),
  flow({
    name: "runs.steer",
    confirm: "steer the running agent",
    summary: "Send an operator message into a running run",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <message>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, body: Schema.String }),
    handler: ({ runId, body, sourceCard }) => actions.steerRun(runId, body, sourceCard)
  }),
  flow({
    name: "runs.seat",
    confirm: "change the run's seat",
    summary: "Move a run to a different model seat",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <seat>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, seat: Schema.String }),
    handler: ({ runId, seat, sourceCard }) => actions.steerRunSeat(runId, seat, sourceCard)
  }),
  flow({
    name: "runs.thinking",
    confirm: "change the run's thinking level",
    summary: "Change a run's thinking level",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <level>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, thinking: Schema.String }),
    handler: ({ runId, thinking, sourceCard }) => actions.steerRunThinking(runId, thinking, sourceCard)
  }),
  flow({
    name: "runs.tools",
    confirm: "change the run's tools",
    summary: "Add tools to a run's active set",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <names,comma-separated>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, toolNames: Schema.String }),
    handler: ({ runId, toolNames, sourceCard }) => actions.steerRunTools(runId, toolNames, sourceCard)
  }),
  flow({
    /* The practice run's transcript is its bundled journal; every other run's is the gateway's projection. */
    name: "runs.logs",
    summary: "Show a run's transcript on its card (--follow keeps it live)",
    runtimeAny: ["cloud", "practice"],
    args: "[sourceCard=id] <runId> [--follow]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      follow: Schema.optional(Schema.Boolean)
    }),
    handler: ({ runId, follow, sourceCard }) => actions.showRunLogs(runId, follow, sourceCard)
  }),
  flow({
    /* The tutorial and the run card share this embedded inspection door. */
    name: "runs.steps",
    summary: "Show a run's steps on its card",
    form: { fields: { runId: { label: "Run", kind: "text" } } },
    runtimeAny: ["cloud", "practice"],
    args: "[sourceCard=id] <runId>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.showRunSteps(runId, sourceCard)
  }),
  /*
   * The run trace's own interactions (factory spec 06 §6): the filter chips
   * and the row / bar selection. Hidden from the palette but registered, so
   * the click, the keyboard and the slash door all dispatch through the
   * registry, and the state they change lives in the card payload (§5), never
   * in the component. These reads are available to the agent in the same
   * embedded card; they never maximize a surface. Each reads the journal
   * already on the card, so the bundled practice run answers them too.
   */
  flow({
    name: "runs.trace.filter",
    summary: "Filter a run's trace: all, running, failed, model, flow, forks or messages",
    runtimeAny: ["cloud", "practice"],
    hidden: true,
    args: "[sourceCard=id] <runId> <all|running|failed|model|flow|forks|messages>",
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      filter: Schema.Literals(["all", "running", "failed", "model", "flow", "forks", "messages"])
    }),
    handler: ({ runId, filter, sourceCard }) => actions.traceFilter(runId, filter, sourceCard)
  }),
  flow({
    name: "runs.trace.select",
    summary: "Select a node of a run's trace, optionally scrubbing to a journal seq",
    /* Selection reads the journal already on the card; the practice run's card is bundled. */
    runtimeAny: ["cloud", "practice"],
    hidden: true,
    args: "[sourceCard=id] <runId> <nodeId> [seq]",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, nodeId: Schema.String, seq: Schema.optional(Schema.Number) }),
    handler: ({ runId, nodeId, seq, sourceCard }) => actions.traceSelect(runId, nodeId, seq, sourceCard)
  }),
  flow({
    name: "runs.coding.select",
    summary: "Inspect or collapse a predicted Change in a coding run",
    runtimeAny: ["cloud", "practice"],
    hidden: true,
    args: "[sourceCard=id] <runId> <changeId>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, changeId: Schema.String }),
    handler: ({ runId, changeId, sourceCard }) => actions.selectCodingChange(runId, changeId, sourceCard)
  }),
  flow({
    name: "runs.trace.view",
    summary: "Show a run's turn explanations or full execution timeline in its embedded card",
    runtimeAny: ["cloud", "practice"],
    hidden: true,
    args: "[sourceCard=id] <runId> <turns|timeline>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, view: Schema.Literals(["turns", "timeline"]) }),
    handler: ({ runId, view, sourceCard }) => actions.traceView(runId, view, sourceCard)
  }),
  flow({
    name: "runs.trace.live",
    summary: "Return a run's trace to its latest recorded turn",
    runtimeAny: ["cloud", "practice"],
    hidden: true,
    args: "[sourceCard=id] <runId>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.traceLive(runId, sourceCard)
  }),
  flow({
    /* The raw journal is a debug surface; the controller gates it on verbose. */
    name: "runs.events",
    summary: "Show a run's raw events on its card (verbose)",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.showRunEvents(runId, sourceCard)
  })
]
