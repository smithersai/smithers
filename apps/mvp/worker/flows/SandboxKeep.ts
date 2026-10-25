import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { Cause, Config, Effect, Layer, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { DEFAULT_IDLE_SECONDS, KEEP_EVERY_SECONDS } from "../../src/features/sandbox/contract.ts"
import * as Budget from "../branch/Budget.ts"
import { Machines } from "../branch/Machines.ts"
import { SandboxUnavailable } from "../branch/Sandboxes.ts"
import { codeOf } from "../ErrorCode.ts"

// `sandbox/Keep { branchId, generation }` (decision 0005 §2, docs/features/sandbox-tools.md#sleep-and-wake): keeps one
// generation of a branch's machine awake while anything happens in it, and puts it to sleep once nothing has for the
// idle time. Sleep is our decision, not Cloudflare's: its inactivity timeout counts requests to the object, not work in
// the box, so a command a terminal left running would otherwise be stopped (Will, 2026-10-19: a sandbox mustn't sleep
// while a process runs).
//
//   sandbox/SleepIfIdle: busy ─▶ the step tries again in KEEP_EVERY_SECONDS, durably, for at most a week
//                        slept ─▶ sandbox/Slept: the generation's terminals end `slept`
//                        gone  ─▶ sandbox/Slept (the machine stopped or restarted already)
//
// The wake that starts a generation starts its `sandbox/Keep` (`Keep` in worker/BranchSandboxes.ts), once per generation
// (`sandbox-keep:<branch>:<generation>`). Asking the machine re-arms its inactivity timeout, so while this flow keeps
// asking, only this flow puts it to sleep. The machine saves the working copy before it sleeps, and the next wake puts
// it back (worker/BranchSandboxes.ts).
//
// It also keeps the sandbox ledger (worker/branch/Budget.ts): each ask that finds the machine busy renews its slot, and
// `sandbox/Slept` closes it, so the machine counts as awake against the limits, and its time as spend, exactly while
// it is awake.

/** The machine is in use: something happened in it within the idle time. The step asks again later. */
export class MachineBusy extends Schema.TaggedError<MachineBusy>()("@smthrs/mvp/sandbox/MachineBusy", {}) {}

/** Postgres couldn't record the sleep. Retried. */
export class SleptUnrecorded extends Schema.TaggedError<SleptUnrecorded>()("@smthrs/mvp/sandbox/SleptUnrecorded", {}) {}

/** Machines `sandbox/Keep` asked about, by `outcome`: `slept`, `busy`, `gone`, or `unavailable`. */
export const keeps = Metric.counter("smithers_sandbox_keeps", {
  description: "Times sandbox/Keep asked a branch's machine whether it is idle, by outcome",
  incremental: true,
})

/** Asking again while the machine is busy or can't answer: every `KEEP_EVERY_SECONDS`, for at most a week. */
export const KEEP_RETRY = RetryPolicy.make({
  initialMs: KEEP_EVERY_SECONDS * 1000,
  factor: 1,
  maxMs: KEEP_EVERY_SECONDS * 1000,
  expirationMs: 7 * 24 * 60 * 60_000,
})

/** Recording: 1 s doubling to a minute, for at most 30 minutes. */
export const RECORD_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

const payload = { branchId: Schema.String, generation: Schema.Number }

/** How the generation ended: put to sleep by this flow, or gone before (stopped, restarted, or another sleep). */
const Ended = Schema.Literals(["slept", "gone"])

/** Puts the generation to sleep if nothing happened in it for the idle time; `MachineBusy` while something did. */
export const SleepIfIdle = Action.make("sandbox/SleepIfIdle", {
  payload,
  success: Ended,
  error: MachineBusy,
  capabilities: ["sandbox:sleep", "db:write:sandbox_generations"],
  retryPolicy: KEEP_RETRY,
})

/** Ends the generation's open terminals `slept` (their shells ended with the machine) and closes its ledger slot. */
export const Slept = Action.make("sandbox/Slept", {
  payload: { branchId: Schema.String, generation: Schema.Number, ended: Ended },
  success: Schema.Struct({ ended: Ended, terminals: Schema.Number }),
  error: SleptUnrecorded,
  capabilities: ["db:write:terminal_sessions", "db:write:sandbox_generations"],
  retryPolicy: RECORD_RETRY,
})

/** `sandbox/Keep`: keeps a generation of a branch's machine awake while it is used, then puts it to sleep. */
export const Keep = Flow.make("sandbox/Keep", {
  description: "Keep a branch's machine awake while anything happens in it, and put it to sleep once nothing has.",
  capabilities: ["sandbox:sleep", "db:write:terminal_sessions", "db:write:sandbox_generations"],
  modelInvocable: false,
  payload,
  success: Slept.successSchema,
  error: Schema.Union([MachineBusy, SleptUnrecorded]),
  body: Node.capture({ sleep: SleepIfIdle.name, slept: Slept.name }, ({ branchId, generation }) =>
    SleepIfIdle.call({ branchId, generation }).pipe(
      Node.bindPlanned(Node.capture({ slept: Slept.name }, (ended: Planned.Planned<"slept" | "gone">) =>
        Slept.call({ branchId, generation, ended }))),
    )),
})

/** How long a machine may be idle before it sleeps: `SANDBOX_IDLE_SECONDS`, `DEFAULT_IDLE_SECONDS` unless set. */
export const idleSeconds = Config.Int("SANDBOX_IDLE_SECONDS").pipe(Config.withDefault(DEFAULT_IDLE_SECONDS))

/** The steps over the host's `Machines` and `database`, the machine idle for `idleMs` before it sleeps. */
export const steps = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, idleMs: number) => {
  const sleepIfIdle = ({ branchId, generation }: typeof SleepIfIdle.payloadSchema.Type) =>
    Effect.flatMap(Machines, (machines) => machines.sleepIfIdle(branchId, generation, idleMs)).pipe(
      Effect.catchTag("@smthrs/mvp/branch/SandboxUnavailable", (error: SandboxUnavailable) =>
        Effect.as(
          Effect.logWarning("sandbox.keep").pipe(Effect.annotateLogs({ branchId, generation, errorCode: codeOf(error) })),
          "unavailable" as const,
        )),
      Effect.tap((outcome) => Metric.update(Metric.withAttributes(keeps, { outcome }), 1)),
      // A busy machine is awake: its ledger slot is renewed. A renewal Postgres refused is logged; the next ask renews it.
      Effect.tap((outcome) =>
        outcome === "busy"
          ? Budget.seen(branchId, generation).pipe(
            Effect.provide(database),
            Effect.catchCause((cause) =>
              Effect.logWarning("sandbox.keep.seen").pipe(
                Effect.annotateLogs({ branchId, generation, errorCode: codeOf(Cause.squash(cause)) }),
              )
            ),
          )
          : Effect.void
      ),
      Effect.flatMap((outcome) =>
        outcome === "slept" || outcome === "gone" ? Effect.succeed(outcome) : Effect.fail(new MachineBusy())
      ),
      Effect.withSpan("sandbox.keep", { attributes: { "smithers.branch.id": branchId } }),
    )

  const slept = ({ branchId, generation, ended }: typeof Slept.payloadSchema.Type) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`
        UPDATE terminal_sessions SET status = 'ended', ended_reason = 'slept', ended_at = now(), updated_at = now()
        WHERE branch_id = ${branchId} AND generation = ${generation} AND status = 'open'
        RETURNING id`
      yield* Budget.ended(branchId, generation)
      yield* Effect.logInfo("sandbox.slept").pipe(
        Effect.annotateLogs({ branchId, generation, ended, terminals: rows.length }),
      )
      return { ended, terminals: rows.length }
    }).pipe(
      Effect.provide(database),
      Effect.mapError(() => new SleptUnrecorded()),
      Effect.withSpan("sandbox.slept", { attributes: { "smithers.branch.id": branchId } }),
    )

  return { sleepIfIdle, slept }
}

/** Registers `sandbox/Keep` with the program's captured idle time and the host's `Machines`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, idleMs = DEFAULT_IDLE_SECONDS * 1000) => {
  const implementation = steps(database, idleMs)
  return Interpreter.layerWithImplementations(
    Keep,
    Layer.mergeAll(SleepIfIdle.toLayer(implementation.sleepIfIdle), Slept.toLayer(implementation.slept)),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
