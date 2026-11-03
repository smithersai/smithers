/**
 * Diagnose a broken branch and propose the minimal recovery command sequence.
 *
 * Port of the 0.x `branch-doctor.jsx`. An inspector agent reports the raw
 * branch state, a diagnosis agent names the root cause and severity, and a
 * planner agent lists the recovery commands, each marked safe or not. Only
 * when the caller sets `autoExecute` do the safe commands run, and the unsafe
 * ones are skipped; otherwise the plan has no execution step at all. A summary
 * reports the diagnosis, the plan and what ran.
 *
 * 0.x ran the safe commands with an agent told to skip the rest; here the flow splits them and a deterministic `Action` a host implements runs them, because the 1.0 completion brake refuses an agent's report of commands its run never recorded.
 * `Intervene` does not fit: it has one propose step where 0.x diagnoses and then plans, and 0.x gates execution on an input flag, not an approval.
 * 0.x's `.mdx` prompts were placeholders that printed their props; the prompts here state the same props.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Level = Schema.Literals(["low", "medium", "high"])

/** The raw branch state. */
export const Inspection = Schema.Struct({
  branch: Schema.String.annotate({ description: "Current branch name" }),
  conflictedFiles: Schema.Array(Schema.String).annotate({ description: "Files in a conflicted state" }),
  divergedCommits: Schema.Number.annotate({ description: "Number of commits ahead/behind the base branch" }),
  unresolvedCherryPicks: Schema.Array(Schema.String).annotate({
    description: "SHAs of partially applied cherry-picks"
  }),
  staleGeneratedFiles: Schema.Array(Schema.String).annotate({
    description: "Generated files that differ from what the source would produce"
  }),
  statusSummary: Schema.String.annotate({ description: "Raw git status / rebase state summary" })
})

/** What went wrong. */
export const Diagnosis = Schema.Struct({
  rootCause: Schema.Literals(["bad-rebase", "partial-cherry-pick", "divergent-generated-files", "mixed", "unknown"])
    .annotate({ description: "Primary root cause category" }),
  details: Schema.String.annotate({ description: "Detailed explanation of what went wrong" }),
  severity: Level.annotate({ description: "How damaged the branch is" }),
  affectedPaths: Schema.Array(Schema.String).annotate({ description: "Files or directories most impacted" })
})

/** One recovery command. */
export const Command = Schema.Struct({
  command: Schema.String.annotate({ description: "The git or shell command to run" }),
  purpose: Schema.String.annotate({ description: "Why this step is needed" }),
  safe: Schema.Boolean.annotate({ description: "Whether this command is non-destructive" })
})

/** The recovery plan. */
export const RecoveryPlan = Schema.Struct({
  commands: Schema.Array(Command).annotate({ description: "Ordered list of recovery commands" }),
  estimatedRisk: Level.annotate({ description: "Overall risk of the recovery plan" }),
  manualStepsRequired: Schema.Array(Schema.String).annotate({ description: "Steps that need human judgement" })
})

/** What the executor ran. */
export const Execution = Schema.Struct({
  executedCommands: Schema.Array(Schema.Struct({
    command: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String
  })).annotate({ description: "Commands that were actually run" }),
  skippedUnsafe: Schema.Array(Schema.String).annotate({ description: "Commands skipped because they were not safe" }),
  success: Schema.Boolean.annotate({ description: "Whether all executed commands succeeded" })
})

/** What the flow settles with. */
export const Output = Schema.Struct({
  rootCause: Schema.String.annotate({ description: "The diagnosed root cause of the branch damage" }),
  recoveryCommands: Schema.Array(Schema.String).annotate({
    description: "The full ordered list of recovery commands"
  }),
  executed: Schema.Boolean.annotate({ description: "Whether safe recovery steps were run" }),
  summary: Schema.String.annotate({ description: "Human-readable summary of diagnosis and recovery" })
})

type Diagnosis = typeof Diagnosis.Type
type RecoveryPlan = typeof RecoveryPlan.Type
type Execution = typeof Execution.Type

/** Reports the branch state without interpreting it. */
export const Inspect = AgentAction.make("examples/BranchDoctor/Inspect", {
  payload: { repoPath: Schema.String, baseBranch: Schema.String, symptoms: Schema.Array(Schema.String) },
  output: Inspection,
  seat,
  system: [
    `You are a git inspector. Examine the repository state: check for conflicts, ongoing rebases, cherry-pick state, and generated files that have diverged. Report raw findings without interpretation.`
  ],
  prompt: ({ baseBranch, repoPath, symptoms }) =>
    `Inspect the branch state.\n\nRepository: ${repoPath}\nBase branch: ${baseBranch}\nSymptoms: ${
      JSON.stringify(symptoms)
    }`
})

/** Names the root cause and rates the damage. */
export const Diagnose = AgentAction.make("examples/BranchDoctor/Diagnose", {
  payload: { inspection: Inspection, symptoms: Schema.Array(Schema.String) },
  output: Diagnosis,
  seat,
  system: [
    `You are a git diagnosis expert. Given raw inspection data about a broken branch, determine the root cause—bad rebase, partial cherry-pick, divergent generated files, or a mix. Explain what happened and rate the severity.`
  ],
  prompt: ({ inspection, symptoms }) =>
    `Diagnose this branch.\n\nInspection: ${JSON.stringify(inspection)}\nSymptoms: ${JSON.stringify(symptoms)}`
})

/** Lists the smallest recovery, each command marked safe or not. */
export const Plan = AgentAction.make("examples/BranchDoctor/Plan", {
  payload: { diagnosis: Diagnosis, inspection: Inspection, repoPath: Schema.String, baseBranch: Schema.String },
  output: RecoveryPlan,
  seat,
  system: [
    `You are a git recovery planner. Given a diagnosis, produce the minimal sequence of commands to restore the branch to a healthy state. Mark each command as safe (non-destructive) or unsafe. Prefer the smallest possible recovery—abort and redo only when strictly necessary.`
  ],
  prompt: ({ baseBranch, diagnosis, inspection, repoPath }) =>
    `Plan the recovery.\n\nRepository: ${repoPath}\nBase branch: ${baseBranch}\nDiagnosis: ${
      JSON.stringify(diagnosis)
    }\nInspection: ${JSON.stringify(inspection)}`
})

/** One command that ran. */
export const Executed = Schema.Struct({ command: Schema.String, exitCode: Schema.Number, output: Schema.String })

/**
 * Runs `commands` in order in the repository and reports each one's exit code
 * and output. The flow hands it only the safe commands. A host implements it
 * with its shell; the tests implement it with a deterministic layer.
 */
export const Execute = Action.make("examples/BranchDoctor/Execute", {
  payload: { commands: Schema.Array(Schema.String), repoPath: Schema.String },
  success: Schema.Array(Executed)
})

/** Splits the plan into the commands that may run and the ones 0.x skipped as unsafe. */
const partition = ({ commands }: RecoveryPlan) => ({
  safe: commands.filter((c) => c.safe).map((c) => c.command),
  unsafe: commands.filter((c) => !c.safe).map((c) => c.command)
})

/** What ran, in 0.x's execution shape. */
const executionOf = (ran: ReadonlyArray<typeof Executed.Type>, unsafe: ReadonlyArray<string>): Execution => ({
  executedCommands: ran,
  skippedUnsafe: unsafe,
  success: ran.every((c) => c.exitCode === 0)
})

/** The summary. Pure, so it is a `Node.map`, not a step. */
const summarize = (
  autoExecute: boolean,
  { diagnosis, execution, plan }: {
    readonly diagnosis: Diagnosis
    readonly plan: RecoveryPlan
    readonly execution: Execution | null
  }
): typeof Output.Type => ({
  rootCause: diagnosis.rootCause,
  recoveryCommands: plan.commands.map((c) => c.command),
  executed: execution?.success ?? false,
  summary: [
    `BranchDoctor diagnosed "${diagnosis.rootCause}" (severity: ${diagnosis.severity}).`,
    `Recovery plan: ${plan.commands.length} commands (risk: ${plan.estimatedRisk}).`,
    autoExecute
      ? `Executed ${execution?.executedCommands.length ?? 0} safe commands, skipped ${
        execution?.skippedUnsafe.length ?? 0
      } unsafe.`
      : "Dry-run only — no commands were executed.",
    ...(plan.manualStepsRequired.length > 0
      ? [`Manual steps still needed: ${plan.manualStepsRequired.join("; ")}`]
      : [])
  ].join(" ")
})

/**
 * The flow. `autoExecute` is real at plan time, so a dry run's plan holds no
 * execution step rather than one a branch skips.
 */
export const BranchDoctor = Flow.make("examples/BranchDoctor", {
  payload: {
    repoPath: Schema.String,
    baseBranch: Schema.optional(Schema.String),
    symptoms: Schema.optional(Schema.Array(Schema.String)),
    autoExecute: Schema.optional(Schema.Boolean)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ autoExecute = false, baseBranch = "main", repoPath, symptoms = [] }) =>
    Node.bindPlanned(
      Inspect.call({ repoPath, baseBranch, symptoms }),
      (inspection: Planned.Planned<typeof Inspection.Type>) =>
        Node.bindPlanned(
          Diagnose.call({ inspection, symptoms }),
          (diagnosis: Planned.Planned<Diagnosis>) =>
            Node.bindPlanned(
              Plan.call({ diagnosis, inspection, repoPath, baseBranch }),
              (plan: Planned.Planned<RecoveryPlan>) =>
                autoExecute
                  ? Node.bindPlanned(
                    Node.map(Node.succeed(plan), partition),
                    (split: Planned.Planned<ReturnType<typeof partition>>) =>
                      Node.bindPlanned(
                        Execute.call({ commands: split.safe, repoPath }),
                        (ran: Planned.Planned<ReadonlyArray<typeof Executed.Type>>) =>
                          Node.map(
                            Node.succeed({ diagnosis, plan, ran, unsafe: split.unsafe }),
                            (found) =>
                              summarize(true, {
                                diagnosis: found.diagnosis,
                                plan: found.plan,
                                execution: executionOf(found.ran, found.unsafe)
                              })
                          )
                      )
                  )
                  : Node.map(Node.succeed({ diagnosis, plan }), (found) =>
                    summarize(false, { ...found, execution: null }))
            )
        )
    )
})

/** Every agent step the flow calls. The host implements {@link Execute}. */
export const layer = Layer.mergeAll(Inspect.layer, Diagnose.layer, Plan.layer)
