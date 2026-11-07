import { Action, ExternalJob, Flow, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { SandboxTools } from "@smthrs/sandbox"
import { Effect, Layer, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { CALL_FAILURES, COMMAND_LIMIT_SECONDS } from "../../src/features/sandbox/contract.ts"
import { Machines } from "#vibelang/emitted/worker/branch/Machines"
import { CheckoutFailed, SandboxBranch, SandboxStartTimedOut, SandboxUnavailable } from "#vibelang/emitted/worker/branch/Sandboxes"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import { Command, ToolCall } from "./SandboxCommand.ts"

// `sandbox/Call { callId, ownerId, branch, call }` (decision 0005 §3 and §5, docs/features/sandbox-tools.md#the-remote-flow):
// runs one sandbox tool on a branch's machine, as the person who asked. `POST /api/sandbox/calls` admits it (signed
// in, may edit the branch, a branch that isn't locked) and records its `running` row, then starts this flow, one
// execution per call (`sandbox-call:<id>`).
//
//   sandbox/Tool (wake the machine, run the tool as the person's user) ─▶ sandbox/Settle (done, with the result)
//   a `run`: sandbox/Command (its own job: start, park between probes, collect; worker/flows/SandboxCommand.ts) ─┘
//        └ failed: refused, lost, no machine, no checkout ─▶ sandbox/ToolFailed ─▶ sandbox/Settle (failed, with why)
//
// It runs remotely because it needs a machine (decision 0011 §2). The host injects the machine (`Machines`: on
// Cloudflare, the branch's `SandboxObject` and its container) and Postgres. The tool's result is the step's journaled
// success, so a replay reads it and never runs the tool again. A command holds no step while it runs: it is the child
// `sandbox/Command` job, which starts it detached once and parks between probes, so a long one (an install of up to an
// hour, `COMMAND_LIMIT_SECONDS`) outlives any one host's drive and settles once. Every other tool holds its step, and a
// command a step held would stop at 600 s (`SandboxTools.limits.maxTimeoutSeconds`).

/** Postgres couldn't record the outcome. Retried. */
export class SettleUnavailable extends Schema.TaggedError<SettleUnavailable>()(
  "@smthrs/mvp/sandbox/SettleUnavailable",
  {},
) {}

/** Calls `sandbox/Call` settled, by `tool` and `outcome`: `done`, or the failure. */
export const calls = Metric.counter("smithers_sandbox_calls", {
  description: "Sandbox tool calls sandbox/Call settled, by tool and outcome",
  incremental: true,
})

/**
 * Running a tool while the machine can't answer: 1 s doubling to 15 s, for at most 2 minutes. A refusal, a lost
 * command and a refused checkout aren't retried; a command is fenced, so trying again never runs it twice.
 */
export const TOOL_RETRY = RetryPolicy.make({
  initialMs: 1_000,
  factor: 2,
  maxMs: 15_000,
  expirationMs: 2 * 60_000,
  nonRetryable: [
    "@smthrs/sandbox/SandboxTools/ToolRefused",
    "@smthrs/sandbox/SandboxTools/ToolLost",
    "@smthrs/mvp/branch/CheckoutFailed",
    "@smthrs/mvp/branch/SandboxStartTimedOut",
  ],
})

/** Settling: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export const SETTLE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

const CallId = Schema.String.check(Schema.isUUID())

/**
 * What a run is for: the call, the person it runs as, the branch whose machine runs it, and the tool's input, a command
 * of up to the job's limit.
 */
const payload = { callId: CallId, ownerId: Schema.String, branch: SandboxBranch, call: ToolCall(COMMAND_LIMIT_SECONDS) }

/** How a call ended: done with the tool's result on a generation of the machine, or failed and why. */
export const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("done"), result: SandboxTools.Result, generation: Schema.optional(Schema.Number) }),
  Schema.Struct({ status: Schema.Literal("failed"), failure: Schema.Literals(CALL_FAILURES) }),
])
export type Outcome = typeof Outcome.Type

/** What the tool step can fail with. */
const ToolError = Schema.Union([
  SandboxTools.ToolRefused,
  SandboxTools.ToolLost,
  SandboxUnavailable,
  SandboxStartTimedOut,
  CheckoutFailed,
])

/** What running a call can fail with: the tool step's failures, and a command job's (`sandbox/Command`). */
const CallError = Schema.Union([
  ...ToolError.members,
  SandboxTools.ToolUnavailable,
  ExternalJob.ExternalJobLost,
  ExternalJob.ExternalJobTimedOut,
  Sleep.SleepRequestInvalid,
])
type CallError = typeof CallError.Type

/** Wakes the branch's machine and runs the tool in it as the person's own user: the done outcome. */
export const Tool = Action.make("sandbox/Tool", {
  payload: { branch: SandboxBranch, ownerId: Schema.String, callId: CallId, call: SandboxTools.Call },
  success: Outcome,
  error: ToolError,
  capabilities: ["sandbox:wake", "sandbox:exec"],
  retryPolicy: TOOL_RETRY,
})

/** What a failure means to the call. */
export const ToolFailed = Action.make("sandbox/ToolFailed", {
  payload: { error: CallError },
  success: Outcome,
  tier: "sealed",
})

/** Records how the call ended on its row, only while it is `running`. */
export const Settle = Action.make("sandbox/Settle", {
  payload: { callId: CallId, tool: Schema.String, outcome: Outcome },
  success: Schema.Struct({ settled: Schema.Boolean }),
  error: SettleUnavailable,
  capabilities: ["db:write:sandbox_calls"],
  retryPolicy: SETTLE_RETRY,
})

/** `sandbox/Call`: runs one sandbox tool on a branch's machine and records how it ended. */
export const SandboxCall = Flow.make("sandbox/Call", {
  description: "Run one sandbox tool on a branch's machine as the person who asked, and record its result.",
  capabilities: ["sandbox:wake", "sandbox:exec", "db:write:sandbox_calls"],
  modelInvocable: false,
  payload,
  success: Settle.successSchema,
  // The tool's failures are recorded on the row and never escape; the union says what the steps may fail with.
  error: Schema.Union([SettleUnavailable, CallError]),
  body: Node.capture(
    { tool: Tool.name, command: Command._tag, failed: ToolFailed.name, settle: Settle.name },
    ({ callId, ownerId, branch, call }) =>
      Node.succeed(call).pipe(
        Node.branch({
          if: Node.capture({ tool: "run" }, (asked: SandboxTools.Call) => asked.tool === "run"),
          then: (run) =>
            Command.call({ target: { branch, ownerId, callId }, call: run as Planned.Planned<typeof SandboxTools.Run.Type> })
              .pipe(Node.map(Node.capture({ outcome: "done" }, ranOf))),
          else: () => Tool.call({ branch, ownerId, callId, call }),
        }),
        Node.catch({
          onFailure: Node.capture({ failed: ToolFailed.name }, (error: Planned.Planned<CallError>) =>
            ToolFailed.call({ error })),
        }),
        Node.bindPlanned(Node.capture({ settle: Settle.name }, (outcome: Planned.Planned<Outcome>) =>
          Settle.call({ callId, tool: call.tool, outcome }))),
      ),
  ),
})

/** A command job's result as the call's done outcome. The job records no machine generation. */
const ranOf = (result: typeof SandboxTools.RunResult.Type): Outcome => ({ status: "done", result })

/** The failure a tool's error records. */
export const failureOf = (error: CallError): Outcome => ({
  status: "failed",
  failure: error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused"
    ? error.reason
    : error._tag === "@smthrs/sandbox/SandboxTools/ToolLost" || error._tag === "@smthrs/flow/ExternalJobLost"
    ? "lost"
    : error._tag === "@smthrs/mvp/branch/CheckoutFailed"
    ? "checkout"
    : error._tag === "@smthrs/mvp/branch/SandboxStartTimedOut"
    ? "start_timeout"
    : "unavailable",
})

/**
 * Writes `outcome` to call `callId`'s row while it is `running`: whether it did. The result is stored as JSON for the
 * person who asked; nothing logs it.
 */
export const settle = (callId: string, outcome: Outcome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = outcome.status === "done"
      ? yield* sql`
        UPDATE sandbox_calls SET status = 'done', result = ${JSON.stringify(outcome.result)}::jsonb,
          generation = ${outcome.generation ?? null}, settled_at = now()
        WHERE id = ${callId} AND status = 'running' RETURNING id`
      : yield* sql`
        UPDATE sandbox_calls SET status = 'failed', failure = ${outcome.failure}, settled_at = now()
        WHERE id = ${callId} AND status = 'running' RETURNING id`
    return { settled: rows.length > 0 }
  })

/** The steps over the host's `Machines` and `database`; each records ids, the tool and outcomes, never content. */
export const steps = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const tool = ({ branch, ownerId, callId, call }: typeof Tool.payloadSchema.Type) =>
    Effect.flatMap(Machines, (machines) => machines.tool(branch, ownerId, callId, call)).pipe(
      Effect.map(({ result, generation }): Outcome => ({ status: "done", result, generation })),
      Effect.tapError((error) =>
        Effect.logWarning("sandbox.tool").pipe(
          Effect.annotateLogs({ callId, branchId: branch.branchId, tool: call.tool, errorCode: codeOf(error) }),
        )
      ),
      Effect.withSpan("sandbox.call.tool", {
        attributes: { "smithers.branch.id": branch.branchId, "smithers.sandbox.tool": call.tool },
      }),
    )

  const failed = ({ error }: typeof ToolFailed.payloadSchema.Type) => Effect.succeed(failureOf(error))

  const record = ({ callId, tool, outcome }: typeof Settle.payloadSchema.Type) =>
    settle(callId, outcome).pipe(
      Effect.provide(database),
      Effect.mapError(() => new SettleUnavailable()),
      Effect.tap(({ settled }) => {
        const result = outcome.status === "done" ? "done" : outcome.failure
        return Effect.andThen(
          settled ? Metric.update(Metric.withAttributes(calls, { tool, outcome: result }), 1) : Effect.void,
          Effect.logWithLevel(outcome.status === "done" ? "Info" : "Warn")("sandbox.call").pipe(
            Effect.annotateLogs({
              callId,
              tool,
              outcome: result,
              settled,
              ...(outcome.status === "done" && outcome.result.tool === "run"
                ? { exitCode: outcome.result.exitCode, timedOut: outcome.result.timedOut }
                : {}),
            }),
          ),
        )
      }),
      Effect.withSpan("sandbox.call.settle", { attributes: { "smithers.sandbox.call.id": callId } }),
    )

  return { tool, failed, record }
}

/**
 * Registers `sandbox/Call` with its steps over `database` and the host's `Machines`. A `run` call's `sandbox/Command` is
 * registered beside it, by `SandboxCommand.registration` (worker/ExecutionHost.ts `withSandboxTools`).
 */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const implementation = steps(database)
  return Interpreter.layerWithImplementations(
    SandboxCall,
    Layer.mergeAll(
      Tool.toLayer(implementation.tool),
      ToolFailed.toLayer(implementation.failed),
      Settle.toLayer(implementation.record),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
