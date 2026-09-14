/**
 * Observe parked runs without mistaking an expected wait for a stalled action.
 *
 * One run receives its answer and finishes. Another remains parked while a
 * monitor reads its state and records a diagnosis. The event wait stays
 * healthy even when recovery of stalled or wedged runs is explicitly enabled.
 *
 * The example compares a positive alert delay with a zero-delay policy. A
 * known event wait is not an unhealthy condition, so neither policy pages
 * about it. A short alert delay must not manufacture a stall.
 */
import { Control, ControlLive, Monitor, SqlControlRuntime } from "@smthrs/control"
import { Action, DurableDeferred, Flow, Interpreter, WaitFor } from "@smthrs/flow"
import { Alerts, NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine, requirements } from "./durable-layer.ts"
import { parkRun } from "./park-run.ts"

/** What the supervision loop concluded. */
export interface Summary {
  /** What the run whose approval arrived returned. */
  readonly answered: unknown
  /** The status the control plane reported for the unanswered run. */
  readonly parked: string
  /** What the parked run was waiting for, as the engine recorded it. */
  readonly waitingFor: string | undefined
  /** The health of each monitor beat, in order. */
  readonly beats: ReadonlyArray<Monitor.Health>
  /** The remedy the monitor applied, once it had a receipt for it. */
  readonly healed: Monitor.Remedy | undefined
  /** Alerts raised under the production delay. */
  readonly quiet: number
  /** The conditions the impatient policy paged about. */
  readonly paged: ReadonlyArray<string>
  /** Alerts a second tick raised. The healthy wait still raises none. */
  readonly repaged: number
  /** Coalescing keys pending on the notification queue. */
  readonly pending: ReadonlyArray<string>
}

/** The wait point both runs park on, and the resolver's half of it. */
const approval = WaitFor.deferred("approval")

/**
 * The supervised flow: one step, which waits for an approval.
 *
 * The wait's failure is declared rather than swallowed. `WaitFor` refuses a
 * payload that does not name exactly one reachable wait point, and a body that
 * hid that would turn an addressing mistake into a run that parks forever.
 */
export const Supervised = Flow.make("examples/Supervised", {
  payload: {},
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () => WaitFor.action.call({ name: "approval" })
})

/** The run whose approval arrives. */
const answeredRunId = "examples-answered"

/** The run nobody answers, and the one the monitor is pointed at. */
const supervisedRunId = "examples-supervised"

/**
 * The policy: page about a run the monitor called wedged.
 *
 * `wedged-node` is not one of the four conditions `defaultDetectors` covers, so
 * the policy brings its own: the field to read, the value that means the
 * condition holds, and the entries to read it on. Narrowing to the beat keeps
 * the heal record, which names the same health, from re-opening a condition
 * the next beat closed.
 */
const rules = (afterMs: number): Alerts.Policy => ({
  defaults: { severity: "warning", owner: "oncall" },
  rules: { "wedged-node": { afterMs, runbook: "https://runbook/wedged-runs" } },
  detectors: {
    "wedged-node": { field: "health", value: "wedged-node", eventTypes: [Monitor.beatEventType] }
  }
})

/**
 * The action implementation and flow registration the engine needs.
 *
 * Declaration and implementation stay separate exactly as in example 02: the
 * flow is data, and this layer attaches the code on a host that can run it.
 */
const registrations = Layer.mergeAll(
  WaitFor.layer,
  Interpreter.layer(Supervised)
).pipe(Layer.provideMerge(Action.layerImplementations))

/**
 * The control plane, over whatever database is beneath it.
 *
 * No `ControlExecutor` is provided, and that is deliberate rather than a
 * shortcut: this control plane starts nothing. It observes and steers runs the
 * engine owns, which is the case a monitor actually meets, and `ControlLive`
 * treats the acceptance port as optional for exactly that reason.
 */
const controlPlane = ControlLive.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlControlRuntime.layer({ owner: { hostId: "examples-monitor", pid: 1, nonce: "monitor" } }).pipe(Layer.orDie),
      NotificationQueue.layer,
      Registry.layerNoop()
    )
  )
)

/**
 * A private engine for execution. The monitor opens the same SQLite file
 * through storage-only services after this engine has shut down.
 */
const stack = (filename: string) =>
  registrations.pipe(
    Layer.provideMerge(durableEngine(filename, "examples-monitor"))
  )

/** The token that names one execution's wait point. */
const tokenFor = (executionId: string) =>
  DurableDeferred.tokenFromExecutionId(approval, { flow: Supervised, executionId })

/**
 * Runs the supervision loop over durable runs.
 *
 * @param filename the SQLite file to run against
 * @param productionDelayMs how long a condition must last before a real policy pages
 */
export const main = (
  filename: string,
  productionDelayMs = 900_000
): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const control = yield* Control.Control

    // Observe the durable park before answering. The next execute rebuilds the
    // awaiting frame from the journal and reads the completed deferred.
    yield* parkRun(answeredRunId, Supervised.execute({}, { executionId: answeredRunId }), stack(filename))
    const answered = yield* Effect.gen(function*() {
      yield* DurableDeferred.succeed(approval, { token: tokenFor(answeredRunId), value: { approved: true } })
      return yield* Supervised.execute({}, { executionId: answeredRunId })
    }).pipe(Effect.provide(stack(filename)))

    // A run that parks and is not answered. Nothing is driving it now, which
    // is the situation a monitor exists for.
    yield* parkRun(supervisedRunId, Supervised.execute({}, { executionId: supervisedRunId }), stack(filename))
    const listed = yield* control.list({ _tag: "runs", filters: { runId: supervisedRunId } })
    const parked = listed._tag === "runs" ? listed.items[0] : undefined

    // Observe beyond the stall threshold with recovery explicitly enabled.
    // Monitor recognizes the durable event wait and leaves it healthy; an
    // unanswered deferred does not authorize a resume or constitute a wedge.
    const report = yield* Monitor.run({
      runId: supervisedRunId,
      monitorId: "examples-oncall",
      intervalMs: 0,
      maxChecks: 4,
      stallBeats: 3,
      autoHeal: ["stalled", "wedged-node"]
    })

    // The alert policy reads the beats the monitor just wrote.
    const patient = yield* Effect.provide(
      Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.tick(supervisedRunId)),
      Alerts.layer(rules(productionDelayMs)).pipe(Layer.provideMerge(Alerts.layerNoop))
    )
    const impatient = Alerts.layer(rules(0)).pipe(Layer.provideMerge(Alerts.layerNoop))
    const paged = yield* Effect.provide(
      Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.tick(supervisedRunId)),
      impatient
    )
    const again = yield* Effect.provide(
      Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.tick(supervisedRunId)),
      impatient
    )
    const queue = yield* NotificationQueue.NotificationQueue
    const pending = yield* queue.pending(supervisedRunId)

    return {
      answered,
      parked: parked?.status ?? "unknown",
      waitingFor: parked?.waitingReason,
      beats: report.beats.map((beat) => beat.health),
      healed: report.beats.find((beat) => beat.healed !== undefined)?.healed,
      quiet: patient.delivered.length,
      paged: paged.delivered.map((alert) => alert.condition),
      repaged: again.delivered.length,
      pending: pending.flatMap((notification) =>
        notification._tag === "system-event" && notification.coalescingKey !== undefined
          ? [notification.coalescingKey]
          : []
      )
    }
  }).pipe(
    Effect.provide(controlPlane.pipe(Layer.provideMerge(requirements(filename)))),
    Effect.scoped,
    Effect.orDie
  )
