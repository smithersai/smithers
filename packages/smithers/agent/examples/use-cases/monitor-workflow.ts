/**
 * Watch another run on a heartbeat and route each health verdict through one flat rule table.
 *
 * Port of the 0.x `monitor-workflow.jsx`, which mounted the 0.x `<Monitor>`.
 * Each beat, after a durable sleep of `intervalMs` (none before the first), a
 * watcher agent classifies the watched run into exactly one condition; a
 * sample whose answer did not fit or whose model call failed settles as no
 * sample, and `maxMisses` beats in a row with no sample fail the monitor. A
 * rule table, kept as data and folded first-match into `Node.branch`
 * predicates as 0.x's `<DecisionTable>` did, sends the condition to a healing
 * agent, a reporting agent, or a person; `healthy` has no rule, so it keeps
 * watching. The previous health sample and matching count persist between beats;
 * healing requires two consecutive samples of the same condition, target, and ownership state. A
 * missed sample resets that evidence. The monitor stops when a sample reports a terminal run status or
 * after `maxChecks` beats, settling with the last beat.
 *
 * 0.x's `continueOnFail` caught every failure; here an unresolved seat, a spent budget or a plugin failure fails the monitor at once, because no later beat can sample past it.
 * 0.x's `<Loop maxIterations={120}>` is a trampoline here: each beat is one round that hands the next beat to itself with `.to()`, so 120 beats never sit in one plan.
 * 0.x's escalation `<HumanTask>` asked for the action row; here it is a JSON `HumanTask` with that row's schema.
 * 0.x's health schema had no `ownerActive`, so its handlers never saw the ownership they were told to confirm; here the watcher reports it, and a stalled or wedged sample heals only when it reports `ownerActive: false`. Any other one escalates.
 * 0.x's prompts name 0.x CLI commands (`smthrs status`, `inspect`, `retry-task`, `up --resume`) that the 1.0 CLI does not have; kept verbatim.
 * 0.x gave the watcher `bash`, `read` and `grep`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask, Sleep } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as StructuredOutput from "@smthrs/harness/StructuredOutput"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/**
 * The failures one agent call may settle as null: its answer did not fit, or
 * its model call failed. A seat the host cannot resolve, a spent budget or a
 * plugin failure fails the monitor instead, because every later call would
 * fail the same way.
 */
const Recoverable = Schema.Union([StructuredOutput.StructuredOutputFailure, HarnessError])

/** The closed set of conditions, in the order the rule table evaluates them. */
export const conditions = [
  "healthy",
  "stalled",
  "wedged-node",
  "runaway-loop",
  "awaiting-human",
  "failing",
  "unknown"
] as const

/** One condition. */
export type Condition = (typeof conditions)[number]

/** Run statuses that mean the watched run is over and the monitor stops. */
export const terminalStatuses: ReadonlyArray<string> = ["finished", "failed", "cancelled", "continued"]

/** The 0.x example's settings. `intervalMs` and `maxChecks` are the payload's defaults. */
export const settings = {
  intervalMs: 60_000,
  maxChecks: 120,
  stallBeats: 3,
  /** Consecutive beats with no sample before the monitor fails rather than watch blind. */
  maxMisses: 3,
  // Only these two heal without a human: resuming a run and retrying a node
  // are idempotent and reversible. Everything else escalates.
  autoHeal: ["stalled", "wedged-node"] as ReadonlyArray<Condition>,
  guidance:
    "Runs here routinely sit on a single agent task for 20+ minutes. Streaming events mean healthy, however long it has been."
} as const

/** The heartbeat's verdict. `condition` is the closed set the table routes on; the rest is evidence. */
export const Health = Schema.Struct({
  condition: Schema.Literals(conditions),
  runStatus: Schema.String.annotate({
    description: "The watched run's status, as reported by `smithers status`/the Gateway."
  }),
  ownerActive: Schema.optional(
    Schema.Boolean.annotate({
      description: "Whether the watched run's runtime owner is live: a pid with a fresh heartbeat. Omitted when unread."
    })
  ),
  targetNodeId: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "The implicated node, when a single one is."
    })
  ),
  evidence: Schema.String.annotate({
    description: "What was actually read: node ids, attempt counts, timestamps, error text."
  }),
  summary: Schema.String
})

/** What a handler, or the person a condition escalated to, did about it. */
export const MonitorAction = Schema.Struct({
  action: Schema.String.annotate({ description: "What the handler did, or `none` when it only observed." }),
  changed: Schema.optional(Schema.Boolean.annotate({ description: "Did the watched run's symptom change?" })),
  summary: Schema.String
})

/** The monitor failed to sample the watched run `misses` beats in a row. */
export const SamplesMissed = Schema.TaggedStruct("examples/MonitorWorkflow/SamplesMissed", {
  watchRunId: Schema.String,
  misses: Schema.Number,
  message: Schema.String
})

/** The last beat, which the flow settles with. */
export const Beat = Schema.Struct({
  beats: Schema.Number,
  health: Schema.NullOr(Health),
  action: Schema.NullOr(MonitorAction)
})

type Health = typeof Health.Type
type MonitorAction = typeof MonitorAction.Type

/** The JSON Schema a person's escalation answer must satisfy: the action row. */
const actionJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    changed: { type: "boolean" },
    summary: { type: "string" }
  },
  required: ["action", "summary"]
}

/** Quotes a value for a POSIX shell. */
const shellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

interface PromptParams {
  readonly watchRunId?: string | undefined
  readonly intervalMs?: number | undefined
  readonly stallBeats?: number | undefined
  readonly autoHeal?: ReadonlyArray<Condition> | undefined
  readonly guidance?: string | undefined
  readonly previous?: Health | null | undefined
  readonly consecutive?: number | undefined
}

/** The monitoring doctrine 0.x's `monitorPrompt` assembled, section by section. */
export const monitorPrompt = (params: PromptParams = {}): string => {
  const runId = params.watchRunId ?? "RUN_ID"
  const stallMs = (params.stallBeats ?? 3) * (params.intervalMs ?? 60_000)
  const autoHeal = params.autoHeal ?? settings.autoHeal
  const allowed = autoHeal.length > 0 ? autoHeal.join(", ") : "(nothing — report only)"
  const terminal = terminalStatuses.join("/")
  const sections = [
    "# Monitor one Smithers run",
    `You are the heartbeat health check for run \`${runId}\`. You run alongside it as a sibling run, sample its health on an interval, classify what you see into exactly one condition, and let the workflow route that condition to a handler. You are not doing the run's work and you must not interfere with it.`,
    "## How to read the run",
    ...(params.previous === undefined ? [] : [
      `Previous heartbeat: ${JSON.stringify(params.previous)}`,
      `Consecutive matching heartbeats: ${params.consecutive ?? 0}`
    ]),
    ...[
      "Read run state ONLY through the Gateway client (`smthrs/gateway-client`) or the public CLI: `bunx smthrs status`, `bunx smthrs inspect RUN_ID --format json`, `bunx smthrs events RUN_ID`, `bunx smthrs node NODE_ID --runId RUN_ID`, `bunx smthrs why RUN_ID`, `bunx smthrs ps`.",
      "NEVER open the store directly. Do not read `.smithers/*.db`, `.smithers/pg`, `smithers.db`, or any SQL over them, and do not parse the Gateway runtime state file. Those are private engine state; reading them races the run and is wrong even when it appears to work.",
      "If a read fails or returns nothing, that is evidence of `unknown` — not a licence to guess from stale memory."
    ].map((line) => `- ${line}`),
    "## Healthy vs unhealthy",
    ...[
      `HEALTHY looks like: the run's status is running (or a terminal ${terminal}); the newest event is more recent than ${stallMs}ms; at least one node changed state, produced output, or emitted events since the previous heartbeat; attempt counts are flat or rising by at most one per node; token burn is roughly linear against progress.`,
      "HEALTHY also covers a run that is legitimately slow: a single long agent task that is still streaming events is working, not stalled. Elapsed time alone is never unhealthy.",
      `STALLED looks like: status is running or paused, no new event for more than ${stallMs}ms, no pending approval and no open human request, and no node in a waiting-timer/waiting-event state that explains the silence.`,
      "WEDGED-NODE looks like: one node has burned repeated attempts whose error signatures are the same (or trivially different) each time, while the rest of the graph is idle behind it. Different errors each attempt is a node making progress through a problem, not a wedge.",
      "RUNAWAY-LOOP looks like: a Loop's iteration count is climbing while its exit condition is no closer, or token burn is accelerating with no matching node completions. Iterations alone are not runaway; iterations without convergence are.",
      "AWAITING-HUMAN looks like: a pending approval gate, an open human request, or a waiting-approval status. This is a healthy parked run, NOT a failure — it needs a person, not a repair.",
      "FAILING looks like: the run status is failed, or a node without continueOnFail has exhausted its retries and nothing downstream can proceed.",
      "UNKNOWN is the honest verdict when reads failed, the evidence contradicts itself, or nothing above fits. Prefer unknown over a confident wrong classification."
    ].map((line) => `- ${line}`),
    "## Evidence you must gather first",
    ...[
      "Gather, every heartbeat, before classifying: the run status; whether its recorded runtime owner is still active (a live pid with a fresh heartbeat); each node's state and attempt/retry count; the timestamp of the newest event (stall time); cumulative token usage; pending approvals and open human requests; and the error signatures in the most recent events.",
      "Quote the evidence you used in `evidence` — node ids, attempt numbers, timestamps, the actual error text. A classification with no citable evidence is an `unknown`.",
      "Never act on a single sample. A condition must hold across at least two consecutive heartbeats before you route it to a healing handler; say so in `evidence` when it does.",
      "Compare against the PREVIOUS heartbeat, not against your expectations. 'Nothing changed since last beat' is the observation that matters."
    ].map((line) => `- ${line}`),
    "## What you may do, and when you must ask",
    ...[
      "Your default action is to OBSERVE AND REPORT. Doing nothing and watching another beat is a correct, complete answer, and it is the right one whenever you are unsure.",
      `You may act autonomously ONLY on these conditions: ${allowed}. Every other condition must be escalated to a human.`,
      `Resume a stalled run only when it has no active runtime owner: \`bunx smthrs up WORKFLOW --resume --run-id ${runId}\` re-enters its durable frame. Retry a wedged node at most once with \`bunx smthrs retry-task WORKFLOW --run-id ${runId} --node-id NODE_ID\`; this resets the node's output and downstream dependents before creating fresh attempts, so report exactly what was reset. Never run either repair against a live owner; escalate instead.`,
      "You may NEVER take a destructive or irreversible action on your own. Do not cancel a run, do not rewind, revert, or time-travel it, do not resolve an approval or answer a human request on the human's behalf, and do not edit the repository. Those require a human decision, always.",
      "ESCALATE to a human instead of guessing when: the condition is not in your auto-heal set; the evidence is contradictory or unreadable; a repair you already applied did not change the symptom; the same condition recurs after two repairs; or the correct fix would be destructive.",
      "When you escalate, state what you saw, what you already tried, what you believe is wrong, and the single specific decision you need. Do not ask an open question."
    ].map((line) => `- ${line}`),
    "## Output",
    `Return exactly one condition from: ${
      conditions.join(" | ")
    }. Include \`runStatus\` (the watched run's status as reported by the CLI/Gateway), \`ownerActive\` (true only for a live runtime-owner pid with a fresh heartbeat), \`targetNodeId\` when a single node is implicated, \`evidence\` quoting what you actually read, and a one-line \`summary\`. When the watched run has reached ${terminal}, report it with condition \`healthy\` (or \`failing\` if it failed) and the monitor will stop.`
  ]
  if (params.guidance) sections.push("## Repo-specific guidance", params.guidance)
  return sections.join("\n\n")
}

/** One heartbeat: sample the watched run and classify it. 0.x gave the watcher the default doctrine as instructions and the run's own as its prompt. */
export const Check = AgentAction.make("examples/MonitorWorkflow/Check", {
  payload: {
    watchRunId: Schema.String,
    intervalMs: Schema.Number,
    stallBeats: Schema.Number,
    autoHeal: Schema.Array(Schema.Literals(conditions)),
    guidance: Schema.String,
    previous: Schema.NullOr(Health),
    consecutive: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  },
  output: Health,
  seat,
  system: [monitorPrompt()],
  prompt: (params) => monitorPrompt(params)
})

/** The instruction one handler is given, as 0.x's `<Monitor>` wrote it for an ownerless run. */
const instruction = (
  condition: Condition,
  watchRunId: string,
  watchWorkflowPath: string | undefined,
  health: Health | null
): string => {
  switch (condition) {
    case "stalled":
      return watchWorkflowPath
        ? `First confirm that the health sample explicitly reports \`ownerActive: false\`; if ownership evidence is absent or true, do not act and report that recovery needs a human. Then resume the ownerless run: \`bunx smthrs up ${
          shellArg(watchWorkflowPath)
        } --resume --run-id ${shellArg(watchRunId)}\`. Confirm with \`bunx smthrs status ${
          shellArg(watchRunId)
        }\` that events resumed. Do nothing else.`
        : "Do not resume: watchWorkflowPath was not supplied. Report that the monitor cannot build a safe resume command."
    case "wedged-node":
      return watchWorkflowPath && typeof health?.targetNodeId === "string" && health.targetNodeId
        ? `First confirm that the health sample explicitly reports \`ownerActive: false\`; if ownership evidence is absent or true, do not act and report that recovery needs a human. Then retry the ownerless wedged node once: \`bunx smthrs retry-task ${
          shellArg(watchWorkflowPath)
        } --run-id ${shellArg(watchRunId)} --node-id ${
          shellArg(health.targetNodeId)
        }\`. This resets that node's output and downstream dependents before creating fresh attempts. Report exactly what was reset. Do not retry a second time — a node that wedges again needs a human.`
        : "Do not retry: watchWorkflowPath or targetNodeId is missing from the health sample. Report the incomplete monitor evidence."
    case "runaway-loop":
      return `Cancel the runaway run: \`bunx smthrs cancel ${
        shellArg(watchRunId)
      }\`. Record the loop id, its iteration count, and the token burn that justified cancelling BEFORE you cancel.`
    case "awaiting-human":
      return "Do NOT resolve the approval or answer the human request. Report what is pending, who it is waiting on, and how long it has been parked, so the operator can act."
    case "failing":
      return "The run failed. Gather the failing node, its error, and the tail of the event log, and report them. Do not retry, rewind, or edit anything."
    default:
      return "Report what you observed."
  }
}

/** One handler: heal or report on the condition the heartbeat named. It runs on the watcher's instructions, as 0.x's did. */
export const Handle = AgentAction.make("examples/MonitorWorkflow/Handle", {
  payload: {
    condition: Schema.Literals(conditions),
    watchRunId: Schema.String,
    watchWorkflowPath: Schema.optional(Schema.String),
    health: Schema.NullOr(Health)
  },
  output: MonitorAction,
  seat,
  system: [monitorPrompt()],
  prompt: ({ condition, health, watchRunId, watchWorkflowPath }) =>
    [
      `The heartbeat classified run ${watchRunId} as "${condition}".`,
      "",
      `Health sample:\n${JSON.stringify(health ?? "(no sample)")}`,
      "",
      instruction(condition, watchRunId, watchWorkflowPath, health),
      "",
      "Read run state only through `smthrs/gateway-client` or the public CLI. Never open the store.",
      "Report exactly what you did and what changed. If the action did not change the symptom, say so plainly rather than trying something else."
    ].join("\n")
})

/** What one rule does: hand the condition to an agent, or ask a person `ask`. */
export type Then = { readonly _tag: "handle" } | { readonly _tag: "escalate"; readonly ask: string }

/** One row of the table: the condition it matches and what it does. */
export interface Rule {
  readonly condition: Condition
  /** Matches only a sample that reports `ownerActive: false`. */
  readonly ownerless?: true
  /** Samples needed before a matching healing rule may act. Reporting needs one. */
  readonly confirmations?: 2
  readonly then: Then
}

const handle: Then = { _tag: "handle" }
const escalate = (ask: string): Then => ({ _tag: "escalate", ask })

/** The question a resume or a retry escalates with when the monitor may not run it. */
const repairQuestion = {
  stalled: "Should this run be resumed?",
  "wedged-node": "Should this node be retried, or is the failure real?"
} as const

/** What each condition does under `autoHeal`, for an ownerless run. `null` is no rule: keep watching. */
const thenFor = (condition: Condition, autoHeal: ReadonlyArray<Condition>): Then | null => {
  switch (condition) {
    case "healthy":
      return null
    case "stalled":
    case "wedged-node":
      return autoHeal.includes(condition) ? handle : escalate(repairQuestion[condition])
    // Cancelling is destructive, so it heals only when `autoHeal` names it.
    case "runaway-loop":
      return autoHeal.includes("runaway-loop") ? handle : escalate(
        "The loop is iterating without converging. Cancel the run, let it keep going, or change its exit condition?"
      )
    // A parked run is healthy; surface it to the operator, never answer for them.
    case "awaiting-human":
    case "failing":
      return handle
    case "unknown":
      return escalate("The monitor could not read consistent evidence and will not guess. What should it do next?")
  }
}

/**
 * The rule table, first match wins, in the order of {@link conditions}. A
 * resume or a retry against a live owner races it, so a healing `stalled` or
 * `wedged-node` rule matches only an ownerless sample, and the same condition
 * with an active or unreported owner escalates.
 */
export const rules: ReadonlyArray<Rule> = conditions.flatMap((condition): ReadonlyArray<Rule> => {
  const then = thenFor(condition, settings.autoHeal)
  if (then === null) return []
  return then._tag === "handle" && (condition === "stalled" || condition === "wedged-node")
    ? [{ condition, ownerless: true, confirmations: 2, then }, { condition, then: escalate(repairQuestion[condition]) }]
    : [{
      condition,
      ...(then._tag === "handle" && condition === "runaway-loop" ? { confirmations: 2 as const } : {}),
      then
    }]
})

/** The question a person is asked when a condition escalates. Pure, so it runs in a `Node.map`. */
const escalation = (
  { ask, condition, health, watchRunId }: {
    readonly condition: string
    readonly watchRunId: string
    readonly ask: string
    readonly health: Health | null
  }
): string =>
  [
    `Run ${watchRunId} looks "${condition}" and the monitor is not allowed to fix it on its own.`,
    "",
    `Evidence: ${JSON.stringify(health?.evidence ?? health?.summary ?? "(none recorded)")}`,
    `Watched run status: ${health?.runStatus ?? "unknown"}`,
    health?.targetNodeId ? `Implicated node: ${health.targetNodeId}` : "",
    "",
    ask
  ].filter(Boolean).join("\n")

type Requirements = Action.Requirement<"examples/MonitorWorkflow/Check" | "examples/MonitorWorkflow/Handle">

interface Watch {
  readonly watchRunId: string
  readonly watchWorkflowPath: string | undefined
}

type Routed = Node.Node<MonitorAction | null, HumanTask.HumanTaskFailed | AgentAction.AgentFailure, Requirements>

/** What a matched rule runs. A handler that fails on its own settles as null, as 0.x's `continueOnFail` did. */
const act = (rule: Rule, health: Planned.Planned<Health | null>, watch: Watch): Routed =>
  rule.then._tag === "handle"
    ? Node.catch(
      Handle.call({
        condition: rule.condition,
        watchRunId: watch.watchRunId,
        watchWorkflowPath: watch.watchWorkflowPath,
        health
      }),
      { error: Recoverable, onFailure: Node.capture({}, () => Node.succeed(null)) }
    )
    : Node.bindPlanned(
      Node.map(
        Node.succeed({ condition: rule.condition, watchRunId: watch.watchRunId, ask: rule.then.ask, health }),
        Node.capture({}, escalation)
      ),
      Node.capture({ rule }, (prompt: Planned.Planned<string>) =>
        HumanTask.decode(MonitorAction)(
          HumanTask.action.call({
            name: `monitor-escalate-${rule.condition}`,
            kind: "json",
            prompt,
            schema: actionJsonSchema
          })
        ))
    )

/**
 * The rule table folded into first-match branches, last rule innermost, as
 * 0.x's `<DecisionTable strategy="first-match">` nested its `<Branch>`es. No
 * match falls through to doing nothing.
 */
const decide = (
  health: Planned.Planned<Health | null>,
  consecutive: Planned.Planned<number>,
  watch: Watch
): Routed =>
  rules.reduceRight<Routed>(
    (otherwise, rule) =>
      Node.branch(Node.succeed({ health, consecutive }), {
        if: Node.capture({
          condition: rule.condition,
          ownerless: rule.ownerless === true
        }, function(sample: { readonly health: Health | null; readonly consecutive: number }) {
          return sample.health !== null && sample.health.condition === this.condition &&
            (!this.ownerless || sample.health.ownerActive === false)
        }),
        then: Node.capture({
          rule,
          watch: { watchRunId: watch.watchRunId, watchWorkflowPath: watch.watchWorkflowPath ?? null }
        }, (matched) =>
          Node.branch(Node.succeed(matched), {
            if: Node.capture({ required: rule.confirmations ?? 1 }, function(sample) {
              return sample.consecutive >= this.required
            }),
            then: Node.capture(
              { rule, watch: { ...watch, watchWorkflowPath: watch.watchWorkflowPath ?? null } },
              (sample) => act(rule, sample.health, watch)
            ),
            else: Node.capture({}, () => Node.succeed(null))
          })),
        else: Node.capture({}, () => otherwise)
      }),
    Node.succeed(null)
  )

/** Whether a beat saw the watched run end. */
const finished = (beat: typeof Beat.Type) => beat.health !== null && terminalStatuses.includes(beat.health.runStatus)

const payload = {
  watchRunId: Schema.String,
  watchWorkflowPath: Schema.optional(Schema.String),
  intervalMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxChecks: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: settings.maxChecks }))),
  /** The beat this round runs, counted from 0. The flow hands it to itself; a caller omits it. */
  beat: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The beats in a row before this one that had no sample. The flow hands it to itself; a caller omits it. */
  misses: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Previous sample and matching streak, persisted across heartbeat rounds. A miss resets both. */
  previous: Schema.optional(Schema.NullOr(Health)),
  consecutive: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
}

const Failure = Schema.Union([
  HumanTask.HumanTaskFailed,
  Sleep.SleepRequestInvalid,
  SamplesMissed,
  AgentAction.AgentFailure
])

/** The declaration shape the self-handoff names. */
type MonitorFlow = Flow.Flow<
  "examples/MonitorWorkflow",
  Schema.Struct<typeof payload>,
  typeof Beat,
  typeof Failure,
  Requirements
>

/** The monitor. One round is one beat; `maxRounds` is the 0.x example's 120-beat bound. */
export const MonitorWorkflow: MonitorFlow = Flow.make("examples/MonitorWorkflow", {
  payload,
  success: Beat,
  error: Failure,
  maxRounds: settings.maxChecks,
  body: Node.capture({}, ({
    beat = 0,
    intervalMs = settings.intervalMs,
    maxChecks = settings.maxChecks,
    misses = 0,
    previous = null,
    consecutive = 0,
    watchRunId,
    watchWorkflowPath
  }: Schema.Struct.Type<typeof payload>) => {
    // A sample that failed on its own must not kill the monitor: the next beat re-samples.
    const sample = Node.catch(
      Check.call({
        watchRunId,
        intervalMs,
        stallBeats: settings.stallBeats,
        autoHeal: [...settings.autoHeal],
        guidance: settings.guidance,
        previous,
        consecutive
      }),
      { error: Recoverable, onFailure: Node.capture({}, () => Node.succeed(null)) }
    )
    const counted = Node.map(
      sample,
      Node.capture({ previous, consecutive }, function(health: Health | null) {
        const same = health !== null && this.previous !== null &&
          health.condition === this.previous.condition &&
          (health.targetNodeId ?? null) === (this.previous.targetNodeId ?? null) &&
          health.ownerActive === this.previous.ownerActive
        return { health, consecutive: health === null ? 0 : same ? this.consecutive + 1 : 1 }
      })
    )
    // Sample immediately on the first beat; pace every beat after it.
    const paced = beat === 0 ? counted : Node.andThen(Sleep.action.call({ millis: intervalMs }), counted)
    const round = {
      beat,
      intervalMs,
      maxChecks,
      misses,
      watchRunId: watchRunId ?? null,
      watchWorkflowPath: watchWorkflowPath ?? null
    }
    // A beat with no sample routes nothing, so everything it settles or hands off is known now.
    const missed = (): Node.Node<
      Flow.Done<typeof Beat.Type> | Flow.To<Schema.Struct.Type<typeof payload>>,
      typeof SamplesMissed.Type
    > =>
      misses + 1 >= settings.maxMisses
        ? Node.fail({
          _tag: "examples/MonitorWorkflow/SamplesMissed" as const,
          watchRunId,
          misses: misses + 1,
          message: `The monitor had no sample of run ${watchRunId} for ${misses + 1} beats in a row.`
        })
        // Running out of beats is the monitor's job ending, not a failure.
        : beat + 1 >= maxChecks
        ? Flow.done({ beats: beat + 1, health: null, action: null })
        : MonitorWorkflow.to({
          watchRunId,
          watchWorkflowPath,
          intervalMs,
          maxChecks,
          beat: beat + 1,
          misses: misses + 1,
          previous: null,
          consecutive: 0
        })
    return Node.bindPlanned(
      paced,
      Node.capture(
        round,
        (observed: Planned.Planned<{ readonly health: Health | null; readonly consecutive: number }>) => {
          const health = observed.health
          return Node.bindPlanned(
            decide(health, observed.consecutive, { watchRunId, watchWorkflowPath }),
            Node.capture(
              round,
              (action: Planned.Planned<MonitorAction | null>) =>
                Node.branch(Node.succeed({ beats: beat + 1, health, action }), {
                  if: Node.capture({}, (last: typeof Beat.Type) => last.health === null),
                  then: Node.capture(round, missed),
                  else: Node.capture(round, () =>
                    Node.branch(Node.succeed({ beats: beat + 1, health, action }), {
                      // Running out of beats is the monitor's job ending, not a failure.
                      if: Node.capture({ bound: beat + 1 >= maxChecks }, function(last: typeof Beat.Type) {
                        return this.bound || finished(last)
                      }),
                      then: Node.capture({}, (last) => Flow.done(last)),
                      else: Node.capture(
                        round,
                        () =>
                          MonitorWorkflow.to({
                            watchRunId,
                            watchWorkflowPath,
                            intervalMs,
                            maxChecks,
                            beat: beat + 1,
                            previous: health,
                            consecutive: observed.consecutive
                          })
                      )
                    }))
                })
            )
          )
        }
      )
    )
  })
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Check.layer, Handle.layer)
