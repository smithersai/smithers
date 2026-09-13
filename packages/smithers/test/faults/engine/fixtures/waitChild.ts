/**
 * A host that parks a run, and the host that comes back for it.
 *
 * The crash family's waiting cases need a run that is genuinely parked in
 * durable state while its host dies. `execute` with `discard` returns as soon
 * as the run suspends, so in `linger` this process prints
 * `PARKED=<executionId>` and then holds the process open until somebody kills
 * it.
 *
 * `resolve` is the replacement host: it satisfies the wait the way a control
 * plane does — answering the human task's token, completing the durable
 * deferred — and then drives the same execution to a result. `settle` skips the
 * resolution, which is what a timer needs and what a second racing host does.
 *
 * Usage:
 *   node waitChild.ts <filename> <executionId> <approval|event|timer> \
 *     <linger|settle|resolve|notify|race-timer> <counterFile> <hostId> [millis]
 */
import { DurableDeferred, FlowRuntime, HumanTask } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import {
  ApprovalFlow,
  EventFlow,
  EventSignal,
  host,
  hostOptions,
  taskName,
  TimerFlow,
  type WaitMode
} from "../harness/waitFlows.ts"

const [filename, executionId, modeArg, phase, counterFile, hostId, millisArg] = process.argv.slice(2)

if (
  filename === undefined || executionId === undefined || modeArg === undefined ||
  phase === undefined || counterFile === undefined || hostId === undefined
) {
  process.stderr.write(
    "usage: waitChild.ts <filename> <executionId> <mode> <linger|settle|resolve|notify|race-timer> <counterFile> <hostId> [millis]\n"
  )
  process.exit(2)
}
if (modeArg !== "approval" && modeArg !== "event" && modeArg !== "timer") {
  process.stderr.write(`waitChild: invalid mode ${modeArg}\n`)
  process.exit(2)
}
if (phase !== "linger" && phase !== "settle" && phase !== "resolve" && phase !== "notify" && phase !== "race-timer") {
  process.stderr.write(`waitChild: invalid phase ${phase}\n`)
  process.exit(2)
}
if (phase === "race-timer" && modeArg !== "timer") {
  process.stderr.write("waitChild: race-timer requires timer mode\n")
  process.exit(2)
}

const mode: WaitMode = modeArg
const options = { filename, counterFile, hostId }
const millis = millisArg === undefined ? 3_000 : Number(millisArg)
const label = "wait"

/** The wait point the first attempt at the question resolves through. */
const approvalToken = DurableDeferred.tokenFromExecutionId(HumanTask.deferred(taskName, 1), {
  flow: ApprovalFlow,
  executionId
})

const announce = (value: unknown): void => {
  process.stdout.write(
    phase === "linger" ? `PARKED=${String(value)}\n` : `SETTLED=${JSON.stringify(value ?? null)}\n`
  )
}

const run = <A, E, R>(
  resolveWait: Effect.Effect<void, unknown, R>,
  body: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      if (phase === "resolve" || phase === "notify") yield* Effect.orDie(resolveWait)
      // `notify` satisfies the wait and leaves. Nobody drives the run: that is
      // what makes the two hosts that come next a real race.
      if (phase === "notify") {
        yield* Effect.sync(() => process.stdout.write("RESOLVED\n"))
        return undefined as never
      }
      const value = yield* body
      announce(value)
      return value
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      Effect.exit
    ) as Effect.Effect<Exit.Exit<A, E>>
  )

const answerQuestion = Effect.suspend(() => HumanTask.answer({ token: approvalToken, value: true }))
const completeSignal = Effect.gen(function*() {
  const runtime = yield* FlowRuntime.FlowRuntime
  yield* runtime.deferredDone(EventSignal, {
    flowName: EventFlow._tag,
    executionId,
    deferredName: EventSignal.name,
    exit: Exit.succeed("signalled")
  })
})

// Completing a deferred schedules a wake. A notifier must register no flows,
// or it can claim the run before the two racing hosts have even started.
const runtimeLayer = phase === "notify"
  ? NodeRuntime.layerHost(hostOptions(options), Layer.empty)
  : host(mode, options)

const exit: Exit.Exit<unknown, unknown> = mode === "approval"
  ? await run(
    answerQuestion as never,
    phase === "linger"
      ? ApprovalFlow.execute({ label }, { executionId, discard: true })
      : ApprovalFlow.execute({ label }, { executionId }),
    runtimeLayer as never
  )
  : mode === "event"
  ? await run(
    completeSignal as never,
    phase === "linger"
      ? EventFlow.execute({ label }, { executionId, discard: true })
      : EventFlow.execute({ label }, { executionId }),
    runtimeLayer as never
  )
  : await run(
    Effect.void as never,
    phase === "linger"
      ? TimerFlow.execute({ millis }, { executionId, discard: true })
      : phase === "race-timer"
      ? Effect.gen(function*() {
        // Both hosts register and observe the same suspended execution before
        // its absolute deadline. They remain alive with their timers armed.
        const parked = yield* TimerFlow.execute({ millis }, { executionId, discard: true })
        process.stdout.write(`PARKED=${parked}\n`)
        return yield* TimerFlow.execute({ millis }, { executionId })
      })
      : TimerFlow.execute({ millis }, { executionId }),
    runtimeLayer as never
  )

if (Exit.isFailure(exit)) {
  process.stderr.write(`${String(exit.cause)}\n`)
  process.exit(1)
}
// A lingering host has parked its run and now exists only to be killed. The
// interval is a real libuv handle: a bare unsettled promise lets Node decide
// the event loop is empty and exit, which is the opposite of lingering.
if (phase === "linger") setInterval(() => {}, 1_000)
else process.exit(0)
