import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { SandboxCommand, SandboxTools } from "@smthrs/sandbox"
import { Schema } from "effect"
import { CALL_FAILURES, COMMAND_LIMIT_SECONDS } from "./contract"

// The sandbox tools (decision 0005 §5, docs/features/sandbox-tools.md): one flow per tool, run on this device's engine
// by a person's slash command, the agent's `ctx.call` and the API alike. Each is two steps:
//
//   sandbox/<tool>/start: POST /api/sandbox/calls, the call's id derived from the run's execution id
//     ─▶ sandbox/<tool>/result: GET /api/sandbox/calls/<id> until the machine settles it
//
// ChatApi admits the call for the person signed in and starts the remote `sandbox/Call`, which runs the tool on the
// branch's machine as that person. The agent's call works in the conversation of the answer it is part of; a person's
// in the conversation their tab showed when they ran it (`conversationId`, pinned by the tab). Closing the tab while a
// command runs changes nothing on the machine: the run resumes with the same call id, and reads the one result.

declare global {
  /** The deployment's `SANDBOX_COMMAND_MAX_SECONDS`, which the build writes in (vite.config.ts); unset where none did. */
  var __SANDBOX_COMMAND_MAX_SECONDS__: number | undefined
}

/**
 * The longest command this deployment runs, in seconds: its `SANDBOX_COMMAND_MAX_SECONDS`, which the build captured
 * from the environment the Worker deploys from and wrote in for `globalThis.__SANDBOX_COMMAND_MAX_SECONDS__`
 * (vite.config.ts), so the run tool states the limit ChatApi holds its calls to rather than learning it from a
 * `too_long` refusal. The job's own limit, `COMMAND_LIMIT_SECONDS`, where no build wrote one in (a test, an eval).
 */
export const COMMAND_MAX_SECONDS: number = globalThis.__SANDBOX_COMMAND_MAX_SECONDS__ ?? COMMAND_LIMIT_SECONDS

/**
 * ChatApi refused the call: signed out (`sign_in`), may not edit the branch (`forbidden`), a locked branch (`locked`), no
 * such conversation (`not_found`), or a request it couldn't read (`invalid`).
 */
export class SandboxCallRefused extends Schema.TaggedError<SandboxCallRefused>()(
  "@smthrs/mvp/sandbox/SandboxCallRefused",
  { reason: Schema.Literals(["sign_in", "forbidden", "locked", "not_found", "invalid"]) },
) {}

/** The command is past the deployment's limit; the agent can ask for a shorter run. */
export class SandboxCommandTooLong extends Schema.TaggedError<SandboxCommandTooLong>()(
  "@smthrs/mvp/sandbox/SandboxCommandTooLong",
  { maxSeconds: Schema.Int },
) {}

/** The machine settled the call failed: it couldn't run, or the tool refused it (`SandboxTools.ToolRefused`). */
export class SandboxCallFailed extends Schema.TaggedError<SandboxCallFailed>()("@smthrs/mvp/sandbox/SandboxCallFailed", {
  failure: Schema.Literals(CALL_FAILURES),
}) {}

/** ChatApi couldn't take or answer the call now: unreachable, or Postgres or the remote host didn't answer. */
export class SandboxCallUnavailable extends Schema.TaggedError<SandboxCallUnavailable>()(
  "@smthrs/mvp/sandbox/SandboxCallUnavailable",
  {},
) {}

/** The machine is still running the call. The result step asks again. */
export class SandboxCallRunning extends Schema.TaggedError<SandboxCallRunning>()(
  "@smthrs/mvp/sandbox/SandboxCallRunning",
  {},
) {}

/** What a tool's flow can fail with. */
export const Failure = Schema.Union([
  SandboxCallRefused,
  SandboxCommandTooLong,
  SandboxCallFailed,
  SandboxCallUnavailable,
  SandboxCallRunning,
])
export type Failure = typeof Failure.Type

const NON_RETRYABLE = [
  "@smthrs/mvp/sandbox/SandboxCallRefused",
  "@smthrs/mvp/sandbox/SandboxCommandTooLong",
  "@smthrs/mvp/sandbox/SandboxCallFailed",
]

/** Starting a call while ChatApi is unreachable: 500 ms doubling to 8 s, for at most 2 minutes. */
export const START_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 8_000,
  expirationMs: 2 * 60_000,
  nonRetryable: NON_RETRYABLE,
})

/**
 * Waiting for the machine: 250 ms doubling to 2 s, for at most the longest command, `maxSeconds`, and 30 minutes more:
 * the command job's own 20 minutes to wake and check out a cold machine, probe and collect, and 10 for the call to
 * launch its job and settle.
 */
export const resultRetry = (maxSeconds: number) =>
  RetryPolicy.make({
    initialMs: 250,
    factor: 2,
    maxMs: 2_000,
    expirationMs: (maxSeconds + 30 * 60) * 1000,
    nonRetryable: NON_RETRYABLE,
  })

/** Waiting for the machine in this deployment: for its longest command (`COMMAND_MAX_SECONDS`) and 30 minutes more. */
export const RESULT_RETRY = resultRetry(COMMAND_MAX_SECONDS)

/** The conversation a person's tab showed when they ran the tool; the agent's call works in its answer's instead. */
const conversationId = Schema.optional(Schema.String.check(Schema.isUUID()))

/** What the start step answers: the call's id. */
export const Started = Schema.Struct({ callId: Schema.String })

/** One tool's flow and its two steps, its result waited for under `retry`. */
const tool = <const T extends SandboxTools.Tool, F extends Schema.Struct.Fields, S extends Schema.Top>(
  name: T,
  options: { readonly fields: F; readonly success: S; readonly description: string },
  retry: RetryPolicy.RetryPolicy = RESULT_RETRY,
) => {
  const payload = { ...options.fields, conversationId }
  const Start = Action.make(`sandbox/${name}/start`, {
    payload,
    success: Started,
    error: Failure,
    retryPolicy: START_RETRY,
  })
  const Result = Action.make(`sandbox/${name}/result`, {
    payload: { callId: Schema.String },
    success: options.success,
    error: Failure,
    retryPolicy: retry,
  })
  const flow = Flow.make(`sandbox/${name}`, {
    description: options.description,
    payload,
    success: options.success,
    error: Failure,
    body: Node.capture({ start: Start.name, result: Result.name }, (input) =>
      Start.call(input as never).pipe(
        Node.bindPlanned(Node.capture({ result: Result.name }, (started) => Result.call({ callId: started.callId }))),
      )),
  }).annotate(Flow.Placement, Placement.client())
  return { tool: name, Start, Result, flow }
}

const path = SandboxTools.Read.fields.path

/**
 * `sandbox/run { command, cwd?, timeoutSeconds? }` where the longest command is `maxSeconds`: the timeout it takes, the
 * limit its description states, and how long its result is waited for.
 */
export const runTool = (maxSeconds: number) =>
  tool("run", {
    fields: {
      command: SandboxTools.Run.fields.command,
      cwd: SandboxTools.Run.fields.cwd,
      timeoutSeconds: SandboxCommand.Run(maxSeconds).fields.timeoutSeconds,
    },
    success: SandboxTools.RunResult,
    description: "Run a shell command on the branch's machine, in its checkout. Answers { exitCode, timedOut, stdout, " +
      "stderr, stdoutBytes, stderrBytes, truncated }: the first 64 KiB of each stream. cwd is relative to the checkout; " +
      `the command stops after timeoutSeconds (60 unless set, ${maxSeconds} at most). It runs once, even if the run ` +
      "resumes.",
  }, resultRetry(maxSeconds))

/** The run tool in this deployment: up to its longest command, `COMMAND_MAX_SECONDS`. */
export const Run = runTool(COMMAND_MAX_SECONDS)

/** `sandbox/read { path }`. */
export const Read = tool("read", {
  fields: { path },
  success: SandboxTools.ReadResult,
  description: "Read a file of the branch's checkout. Answers { path, content, bytes, truncated }: the first 1 MiB " +
    "as text. The path is relative to the checkout.",
})

/** `sandbox/write { path, content }`. */
export const Write = tool("write", {
  fields: { path, content: SandboxTools.Write.fields.content },
  success: SandboxTools.WriteResult,
  description: "Write a file in the branch's checkout, making its folders; it replaces what was there. Answers " +
    "{ path, bytes }. The path is relative to the checkout.",
})

/** `sandbox/list { path? }`. */
export const List = tool("list", {
  fields: { path: SandboxTools.List.fields.path },
  success: SandboxTools.ListResult,
  description: "List a folder of the branch's checkout: the checkout itself unless path is set. Answers { path, " +
    "entries: [{ name, kind, bytes }], truncated }.",
})

/** `sandbox/status {}`. */
export const Status = tool("status", {
  fields: {},
  success: SandboxTools.StatusResult,
  description: "Show the git status of the branch's checkout. Answers { branch, entries: [{ path, index, worktree, " +
    "from? }] }, with git's short status letters; ? is untracked.",
})

/** `sandbox/diff { paths? }`. */
export const Diff = tool("diff", {
  fields: { paths: SandboxTools.Diff.fields.paths },
  success: SandboxTools.DiffResult,
  description: "Show the changes in the branch's checkout since its last commit, as a unified diff with new files " +
    "included. Answers { diff, bytes, truncated }: the first 256 KiB. paths limits it to those files.",
})

/** Every tool, in order. */
export const tools = [Run, Read, Write, List, Status, Diff] as const

/** The tool flows' declarations. */
export const SandboxRun = Run.flow
export const SandboxRead = Read.flow
export const SandboxWrite = Write.flow
export const SandboxList = List.flow
export const SandboxStatus = Status.flow
export const SandboxDiff = Diff.flow
