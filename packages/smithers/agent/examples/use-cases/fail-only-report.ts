/**
 * Run commands, and ask for a root-cause report only when a result is notable.
 *
 * Port of the 0.x `fail-only-report.jsx`. Each command (by default pytest,
 * ruff and tsc) runs, up to four at a time. A command that never reaches
 * an exit code is retained as a failed result with exit code 125. An analyzer
 * agent reads every result and decides whether any is notable. Only a notable analysis reaches
 * the report agent and a `reported` sink row; a quiet one settles with a
 * `quiet` row and no further model call.
 *
 * 0.x ran each command through a runner agent; here {@link RunCommand} is a deterministic `Action.make` step, so a green run spends one model call, the analyzer's.
 * 0.x's runner timeout failed the task; here a timed-out command is a result with exit code 124 and a timeout note, which is how 0.x's run prompt asked the runner to report it.
 * The analyzer and the report agent answer about results they are handed, so they set `claimCap: 0`; a host that arms `claimCap` would otherwise refuse them for naming commands their own sessions never ran.
 * `DriftDetector` does not fit: 0.x compares against no baseline, and its analyzer reads only the commands' own output.
 * 0.x gave the agents `bash` and `read` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { exec } from "node:child_process"

const seat = "anthropic:claude-sonnet-5-5"

/** One command to run, under the name 0.x keyed its task by. */
export const Command = Schema.Struct({ name: Schema.String, cmd: Schema.String })

/** What one command did. */
export const RunResult = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  durationMs: Schema.Number
})

/** The analyzer's answer. */
export const Analysis = Schema.Struct({
  notable: Schema.Boolean,
  failingCommands: Schema.Array(Schema.String),
  regressingCommands: Schema.Array(Schema.String),
  artifacts: Schema.Array(Schema.Struct({
    command: Schema.String,
    category: Schema.Literals(["failure", "regression", "delta"]),
    snippet: Schema.String
  })),
  summary: Schema.String
})

/** The report agent's answer. */
export const Report = Schema.Struct({
  rootCauses: Schema.Array(Schema.Struct({
    command: Schema.String,
    hypothesis: Schema.String,
    confidence: Schema.Literals(["high", "medium", "low"]),
    suggestedFix: Schema.String
  })),
  overallSummary: Schema.String,
  sinkPayload: Schema.String
})

/** The sink row the flow settles with. */
export const Sink = Schema.Struct({
  status: Schema.Literals(["quiet", "reported"]),
  destination: Schema.String,
  summary: Schema.String
})

/** A command did not run to an exit code: it never started, or it died some other way than its timeout. */
export class RunFailed extends Schema.TaggedError<RunFailed>()("examples/FailOnlyReport/RunFailed", {
  command: Schema.String,
  message: Schema.String,
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number)
}) {}

type RunResult = typeof RunResult.Type

/** The commands a run executes when the payload names none. */
export const defaultCommands: ReadonlyArray<typeof Command.Type> = [
  { name: "pytest", cmd: "pytest -q" },
  { name: "lint", cmd: "ruff check ." },
  { name: "typecheck", cmd: "npx tsc --noEmit" }
]

/** The exit code a timed-out command reports, as `timeout(1)` does. */
export const timeoutExitCode = 124

/**
 * Runs one command. A failing exit code is a result, not a failure. The
 * command may change the directory, so it is compensable.
 */
export const RunCommand = Action.make("examples/FailOnlyReport/Run", {
  payload: { command: Schema.String, directory: Schema.String, timeoutMs: Schema.Number },
  success: RunResult,
  error: RunFailed,
  tier: "compensable"
})

/**
 * Runs `command` in a shell in `directory`, killing it after `timeoutMs`.
 *
 * Every exit code is a result, and so is the timeout. Anything else (a
 * missing directory, output past the buffer, a death by another signal) fails
 * the step with {@link RunFailed}; the flow retains its message as a failed
 * result with exit code 125. Each output stream is bounded to 1 MiB.
 */
export const runCommand = (
  { command, directory, timeoutMs }: typeof RunCommand.payloadSchema.Type
): Effect.Effect<RunResult, RunFailed> =>
  Effect.callback<RunResult, RunFailed>((resume, signal) => {
    const startedAt = Date.now()
    exec(command, { cwd: directory, timeout: timeoutMs, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startedAt
      // Node puts the exit code here, a system error name when the command
      // never started, and null when a signal ended it.
      const code: unknown = error === null ? 0 : error.code ?? null
      if (typeof code === "number") {
        return resume(Effect.succeed({ command, exitCode: code, stdout, stderr, durationMs }))
      }
      if (code === null && error?.killed === true) {
        return resume(Effect.succeed({
          command,
          exitCode: timeoutExitCode,
          stdout,
          stderr: `${stderr}Timed out after ${timeoutMs} ms`,
          durationMs
        }))
      }
      return resume(Effect.fail(
        new RunFailed({
          command,
          message: error?.signal ? `Signal ${error.signal}: ${command}` : error?.message ?? "no exit code",
          stdout,
          stderr,
          durationMs
        })
      ))
    })
  })

/** Decides which results are notable. */
export const Analyze = AgentAction.make("examples/FailOnlyReport/Analyze", {
  payload: { results: Schema.Array(RunResult) },
  output: Analysis,
  seat,
  claimCap: 0,
  system: [
    `You are a CI artifact analyst. Examine command outputs to detect
failures, regressions, and notable deltas. Be precise: a non-zero exit code is
always notable, but also look for regression markers in stdout/stderr.`
  ],
  prompt: ({ results }) =>
    `Analyze the following command results and determine if anything is notable:\n\n${
      JSON.stringify(results.map(({ command, durationMs, exitCode, stderr, stdout }) => ({
        command,
        exitCode,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
        durationMs
      })))
    }\n\nA run is notable if:\n- Any command exited with a non-zero code (failure)\n- Any command output contains regression markers or error patterns\n- Any metric shows a significant delta from baseline\n\nClassify each command and produce a summary of notable events.`
})

/** Writes the root-cause report for the notable results. */
export const WriteReport = AgentAction.make("examples/FailOnlyReport/Report", {
  payload: {
    failingCommands: Schema.Array(Schema.String),
    regressingCommands: Schema.Array(Schema.String),
    artifacts: Analysis.fields.artifacts
  },
  output: Report,
  seat,
  claimCap: 0,
  system: [
    `You are a failure analyst. Given notable CI events, produce
root-cause hypotheses with confidence levels and actionable next steps.
Keep reports concise and suitable for a PR comment or Slack message.`
  ],
  prompt: ({ artifacts, failingCommands, regressingCommands }) =>
    `You are a failure analysis agent. Produce a root-cause report for these notable events:\n\nNotable commands: ${
      JSON.stringify([...failingCommands, ...regressingCommands])
    }\nFailure output: ${
      JSON.stringify(artifacts)
    }\n\nFor each failure or regression:\n1. Identify the most likely root cause\n2. Suggest concrete next steps to fix or investigate\n3. Note any patterns across failures (shared dependencies, timing, flakiness)\n\nFormat the report as a concise, actionable summary suitable for a PR comment or Slack message.`
})

/** The sink row after a report. Pure, so it is a `Node.map`, not a step. */
const reported = ({ destination, summary }: { readonly destination: string; readonly summary: string }) => ({
  status: "reported" as const,
  destination,
  summary
})

/** The sink row when no requested command was notable. */
const quiet = (
  { destination, commandCount, runs }: {
    readonly destination: string
    readonly commandCount: number
    readonly runs: ReadonlyArray<RunResult>
  }
) => ({
  status: "quiet" as const,
  destination,
  summary: runs.length === commandCount && runs.every((run) => run.exitCode === 0)
    ? `All ${commandCount} commands passed — no report needed`
    : `Not all ${commandCount} commands passed — no report requested`
})

/** Every command, `concurrency` at a time, retaining runner failures without failing siblings. */
const runAll = (
  commands: ReadonlyArray<typeof Command.Type>,
  options: { readonly directory: string; readonly timeoutMs: number; readonly concurrency: number }
): Node.Node<ReadonlyArray<RunResult>, never, Action.Requirement<"examples/FailOnlyReport/Run">> => {
  if (commands.length === 0) return Node.succeed([])
  // A runner failure remains visible to the analyzer without failing its siblings.
  const members = Object.fromEntries(commands.map(({ cmd }, index) => [
    `${index}`,
    Node.catch(RunCommand.call({ command: cmd, directory: options.directory, timeoutMs: options.timeoutMs }), {
      onFailure: Node.capture(
        { cmd },
        (failure) =>
          Node.map(
            Node.succeed(failure),
            Node.capture({ cmd }, (error): RunResult => ({
              command: cmd,
              // Runner failures use the conventional exit code 125.
              exitCode: 125,
              stdout: error.stdout ?? "",
              stderr: error.stderr ?
                `${error.message}\n${error.stderr}` :
                error.message,
              durationMs: error.durationMs ?? 0
            }))
          )
      )
    })
  ]))
  const joined = Bounded.all(members, { concurrency: options.concurrency })
  return Node.map(joined, Node.capture({}, (ran) => Object.values(ran)))
}

const Positive = Schema.Int.check(Schema.isGreaterThan(0))

/** The flow: run, analyze, and report only what is notable. */
export const FailOnlyReport = Flow.make("examples/FailOnlyReport", {
  description: "Run commands, and ask for a root-cause report only when a result is notable.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
  modelInvocable: false,
  payload: {
    commands: Schema.optional(Schema.Array(Command)),
    directory: Schema.optional(Schema.String),
    maxParallel: Schema.optional(Positive),
    timeoutMs: Schema.optional(Positive),
    sink: Schema.optional(Schema.String)
  },
  success: Sink,
  error: AgentAction.AgentFailure,
  body: Node.capture({}, (
    { commands = defaultCommands, directory = ".", maxParallel = 4, sink = "pr-comment", timeoutMs = 300_000 }
  ) => {
    const run = { commands, sink }
    return Node.bindPlanned(
      runAll(commands, { directory, timeoutMs, concurrency: maxParallel }),
      Node.capture(
        run,
        (runs: Planned.Planned<ReadonlyArray<RunResult>>) =>
          Node.branch(Analyze.call({ results: runs }), {
            if: Node.capture({}, (analysis) => analysis.notable),
            then: Node.capture(run, (analysis) =>
              Node.bindPlanned(
                WriteReport.call({
                  failingCommands: analysis.failingCommands,
                  regressingCommands: analysis.regressingCommands,
                  artifacts: analysis.artifacts
                }),
                Node.capture(
                  run,
                  (report) =>
                    Node.map(
                      Node.succeed({ destination: sink, summary: report.overallSummary }),
                      Node.capture({}, reported)
                    )
                )
              )),
            else: Node.capture(
              run,
              () =>
                Node.map(
                  Node.succeed({ destination: sink, commandCount: commands.length, runs }),
                  Node.capture({}, quiet)
                )
            )
          })
      )
    )
  })
})

/** Every step the flow calls, with commands run on this host. */
export const layer = Layer.mergeAll(RunCommand.toLayer(runCommand), Analyze.layer, WriteReport.layer)
