/**
 * Usage metrics for every flow run: which flows run, and how.
 *
 * The engine records them, so every flow gets them without declaring
 * anything. A run is counted when it is admitted and when its lineage settles,
 * by its flow's tag, its outcome, the door it came through, where it ran and
 * the kind of actor that started it; its duration, the wait before its first
 * step, its steps, retries and durable waits, and the model calls its steps
 * make, with their tokens, are counted beside it.
 *
 * Nothing here carries a payload, a result, a failure's message or who
 * started a run. A flow's tag, a model id and a failure's code are kept, each
 * cleaned to a short identifier and capped at a number of distinct values per
 * process (`other` past the cap), so a host that registers many flows cannot
 * grow the metric series without bound. A door, an actor and a placement are
 * closed sets; any other value reads `other`.
 *
 * Each record is a metric and a log line with the same fields, so a store that
 * holds only logs (Workers Logs, Loki) counts and percentiles them too.
 *
 * @since 1.0.0-rc.17
 */

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { dual } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Interpreter from "./Interpreter.ts"

/**
 * What started a run: a person's button, slash command, view, composer or key; the
 * agent; an API call; an event such as a webhook; a schedule; sync, when a
 * row another device wrote asks this one to act; or another flow.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export const doors = [
  "button",
  "slash",
  "view",
  "composer",
  "key",
  "agent",
  "api",
  "event",
  "schedule",
  "sync",
  "flow",
  "unknown"
] as const

/**
 * A door, or `other` for a value outside {@link doors}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Door = (typeof doors)[number] | "other"

/**
 * The kind of actor that started a run. Until run credentials name one, a
 * caller states it, and an unstated one is `unknown`.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export const actors = ["person", "agent", "app", "plugin", "unknown"] as const

/**
 * An actor kind, or `other` for a value outside {@link actors}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Actor = (typeof actors)[number] | "other"

/**
 * Where a run ran: a browser tab's engine, a Cloudflare Durable Object, a
 * sandbox, or a local Node or Bun program.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export const placements = ["browser", "cloudflare", "sandbox", "local", "unknown"] as const

/**
 * A placement, or `other` for a value outside {@link placements}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Placement = (typeof placements)[number] | "other"

/**
 * How a run's lineage settled: its value (`succeeded`); a failure, declared
 * or a defect (`failed`); refused by the engine before or while it ran, such
 * as a plan or payload a new build no longer reads (`refused`); stopped by a
 * cancellation (`cancelled`); or interrupted with no cancellation asked
 * (`lost`).
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export const outcomes = ["succeeded", "failed", "refused", "cancelled", "lost"] as const

/**
 * The value form of {@link outcomes}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Outcome = (typeof outcomes)[number]

/**
 * What a durable wait waited on: a timer, a signal or event, an approval, a
 * quota, a person's answer, or anything else.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export const waitKinds = ["timer", "signal", "approval", "quota", "human", "other"] as const

/**
 * The value form of {@link waitKinds}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type WaitKind = (typeof waitKinds)[number]

const closed = <const Values extends ReadonlyArray<string>>(values: Values) => {
  const known: ReadonlySet<string> = new Set(values)
  return (value: string | undefined): Values[number] | "other" =>
    value === undefined ? "unknown" : known.has(value) ? value : "other"
}

/**
 * The door a value names: itself when {@link doors} lists it, `unknown` when
 * absent, otherwise `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const door: (value: string | undefined) => Door = closed(doors)

/**
 * The actor kind a value names: itself when {@link actors} lists it, `unknown`
 * when absent, otherwise `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const actor: (value: string | undefined) => Actor = closed(actors)

/**
 * The placement a value names: itself when {@link placements} lists it,
 * `unknown` when absent, otherwise `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const placement: (value: string | undefined) => Placement = closed(placements)

/**
 * The wait kind a parked run's reason reads as: `event` and `signal` are a
 * `signal`, and a reason {@link waitKinds} doesn't list is `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const waitKind = (reason: string): WaitKind =>
  reason === "event" ? "signal" : (waitKinds as ReadonlyArray<string>).includes(reason) ? reason as WaitKind : "other"

/**
 * Who and what started a run, as the caller says: the {@link Door} and the
 * {@link Actor} kind. Never a person's identity.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Origin {
  readonly door: string
  readonly actor: string
}

/**
 * The origin of the runs started in this context. The engine reads it when it
 * admits a run and keeps it with the run, so the run's later records carry
 * it. Unset, a run is `unknown` by `unknown`; a run another run starts is
 * door `flow` by its starter's actor, unless the context names another
 * origin, as an agent's tool call does.
 *
 * @category context
 * @since 1.0.0-rc.17
 */
export const CurrentOrigin = Context.Reference<Origin>("@smthrs/flow/RunMetrics/CurrentOrigin", {
  defaultValue: () => ({ door: "unknown", actor: "unknown" })
})

/**
 * Runs `effect` with `origin` as {@link CurrentOrigin}, so a run it starts is
 * counted under that door and actor.
 *
 * @category context
 * @since 1.0.0-rc.17
 */
export const withOrigin: {
  (origin: Origin): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, origin: Origin): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, E, R>(effect: Effect.Effect<A, E, R>, origin: Origin): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentOrigin, origin)
)

/**
 * The level the usage log lines are written at. `Debug`, the default, keeps
 * them out of a program's ordinary output, such as a command-line tool whose
 * standard output is its answer. A host whose logs are its telemetry sets
 * `Info` (`layerInfoLines`), as the browser engine and the Cloudflare host do:
 * then `flow.run.started` and `flow.model.call` are Info, and
 * `flow.run.settled` is Info when the run succeeded and Warn otherwise. The
 * metrics are recorded either way.
 *
 * @category context
 * @since 1.0.0-rc.17
 */
export const LineLevel = Context.Reference<"Debug" | "Info">("@smthrs/flow/RunMetrics/LineLevel", {
  defaultValue: () => "Debug"
})

/**
 * Writes the usage log lines at Info, for a host whose logs are its telemetry.
 *
 * @category context
 * @since 1.0.0-rc.17
 */
export const layerInfoLines: Layer.Layer<never> = Layer.succeed(LineLevel, "Info")

/** Writes `message` at the level {@link LineLevel} asks for, or Warn for a bad outcome at Info. */
const line = (message: string, warn = false): Effect.Effect<void> =>
  Effect.gen(function*() {
    const level = yield* LineLevel
    yield* (level === "Debug" ? Effect.logDebug : warn ? Effect.logWarning : Effect.logInfo)(message)
  })

/**
 * A bounded set of label values: each value is cleaned to a short identifier,
 * and once `limit` distinct values were seen, every new one reads `other`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Labels {
  readonly of: (value: string) => string
  /** How many distinct values it holds. */
  readonly size: () => number
}

/** The longest label value kept. */
const maxLabelLength = 96

/**
 * A label value as an identifier: letters, digits and `_ . / : @ -` kept,
 * anything else `_`, cut to 96 characters; an empty value is `unknown`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const clean = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9_./:@-]/g, "_").slice(0, maxLabelLength)
  return cleaned.length === 0 ? "unknown" : cleaned
}

/**
 * Makes a {@link Labels} that keeps at most `limit` distinct values.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const makeLabels = (limit: number): Labels => {
  const seen = new Set<string>()
  return {
    of: (value) => {
      const cleaned = clean(value)
      if (seen.has(cleaned)) return cleaned
      if (seen.size >= limit) return "other"
      seen.add(cleaned)
      return cleaned
    },
    size: () => seen.size
  }
}

/**
 * The most distinct flow tags one process labels; later ones read `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const maxFlows = 200

/**
 * The most distinct model ids one process labels.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const maxModels = 50

/**
 * The most distinct failure codes one process labels.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const maxCodes = 100

const flowLabels = makeLabels(maxFlows)
const modelLabels = makeLabels(maxModels)
const codeLabels = makeLabels(maxCodes)

/**
 * A flow's tag as a label, capped at {@link maxFlows} per process.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const flow = (tag: string): string => flowLabels.of(tag)

/**
 * A model id as a label, capped at {@link maxModels} per process.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const model = (id: string): string => modelLabels.of(id)

/**
 * A failure code as a label, capped at {@link maxCodes} per process; `none`
 * for no failure.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const code = (value: string): string => value === "none" ? "none" : codeLabels.of(value)

/** An identifier-shaped string: what a closed code or a tag looks like. */
const identifier = /^[A-Za-z_@][A-Za-z0-9_./:@-]{0,95}$/

/** A failure's code: its `code` when that is a closed code, else its `_tag`, else its error name. */
const codeOf = (error: unknown, fallback: string): string => {
  if (error !== null && typeof error === "object") {
    const record = error as { readonly code?: unknown; readonly _tag?: unknown; readonly name?: unknown }
    if (typeof record.code === "string" && identifier.test(record.code)) return record.code
    if (typeof record._tag === "string" && identifier.test(record._tag)) return record._tag
    if (typeof record.name === "string" && record.name !== "Error" && identifier.test(record.name)) return record.name
  }
  return fallback
}

/**
 * How a run that ended with `exit` settled, and the code of its failure:
 * `none` on success, an interpreter refusal's code (`plan_changed`,
 * `payload_changed`), a typed failure's `code` or tag, a defect's tag or name
 * (`defect` when it has none), or `interrupted`. Never a message.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export const settlement = (exit: Exit.Exit<unknown, unknown>): {
  readonly outcome: Outcome
  readonly code: string
} => {
  if (Exit.isSuccess(exit)) return { outcome: "succeeded", code: "none" }
  const refusal = Interpreter.refusalCode(exit.cause)
  if (Option.isSome(refusal)) return { outcome: "refused", code: refusal.value }
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "lost", code: "interrupted" }
  const failure = exit.cause.reasons.find(Cause.isFailReason)
  if (failure !== undefined) return { outcome: "failed", code: codeOf(failure.error, "failed") }
  const defect = exit.cause.reasons.find(Cause.isDieReason)
  return { outcome: "failed", code: codeOf(defect?.defect, "defect") }
}

/**
 * Milliseconds bucket boundaries for durations: 10 ms to a day.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const durationBoundaries: ReadonlyArray<number> = [
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
  300_000,
  900_000,
  3_600_000,
  21_600_000,
  86_400_000
]

/**
 * Runs admitted, by `flow`, `door`, `actor` and `placement`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const runsStarted = Metric.counter("flows_runs_started", {
  description: "Flow runs admitted, by flow, door, actor and placement",
  incremental: true
})

/**
 * Run lineages settled, by `flow`, `outcome`, `code`, `door`, `actor` and
 * `placement`. A round that hands off to the next round is not a settlement.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const runsSettled = Metric.counter("flows_runs_settled", {
  description: "Flow runs settled, by flow, outcome, code, door, actor and placement",
  incremental: true
})

/**
 * From a run's admission to its settlement, in milliseconds, by `flow`,
 * `outcome` and `placement`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const runDuration = Metric.histogram("flows_run_duration_ms", {
  description: "Milliseconds from a flow run's admission to its settlement",
  boundaries: durationBoundaries
})

/**
 * From a run's admission to the engine first starting it, when its first step
 * can run, in milliseconds, by `flow` and `placement`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const runFirstStep = Metric.histogram("flows_run_first_step_ms", {
  description: "Milliseconds from a flow run's admission to its first step starting",
  boundaries: durationBoundaries
})

/**
 * Step attempts that ran their body, by `flow` and `outcome` (`succeeded`,
 * `failed`, `interrupted`). A step answered from its record is not counted.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const steps = Metric.counter("flows_steps", {
  description: "Flow step attempts that ran, by flow and outcome",
  incremental: true
})

/**
 * Step attempts that failed, by `flow` and `code`: the failure's code (a
 * typed failure's `code` or tag, a defect's tag or name), never its message.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const stepFailures = Metric.counter("flows_step_failures", {
  description: "Flow step attempts that failed, by flow and code",
  incremental: true
})

/**
 * Step attempts after a step's first, by `flow`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const stepRetries = Metric.counter("flows_step_retries", {
  description: "Flow step attempts after a step's first, by flow",
  incremental: true
})

/**
 * Durable waits a run parked on, by `flow` and `kind`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const waits = Metric.counter("flows_waits", {
  description: "Durable waits flow runs parked on, by flow and kind",
  incremental: true
})

/**
 * How long a durable wait lasted, from the park to the run resuming, in
 * milliseconds, by `flow` and `kind`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const waitDuration = Metric.histogram("flows_wait_ms", {
  description: "Milliseconds a flow run stayed parked on a durable wait",
  boundaries: durationBoundaries
})

/**
 * Model calls a flow's steps made, by `flow`, `model` and `outcome`. A step
 * answered from its record calls no model and is not counted.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const modelCalls = Metric.counter("flows_model_calls", {
  description: "Model calls flow steps made, by flow, model and outcome",
  incremental: true
})

/**
 * Tokens those calls reported, by `flow`, `model` and `direction` (`input`,
 * `output`).
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const modelTokens = Metric.counter("flows_model_tokens", {
  description: "Tokens flow steps' model calls reported, by flow, model and direction",
  incremental: true
})

/**
 * Where and by whom a run was started, as its records label it.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RunLabels {
  readonly flow: string
  readonly door: string
  readonly actor: string
  readonly placement: string
}

const runLabels = (labels: RunLabels) => ({
  flow: flow(labels.flow),
  door: door(labels.door),
  actor: actor(labels.actor),
  placement: placement(labels.placement)
})

/**
 * Records a run's admission: a count of {@link runsStarted} and the log line
 * `flow.run.started`, with its execution id.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export const recordStarted = (labels: RunLabels & { readonly executionId: string }): Effect.Effect<void> => {
  const attributes = runLabels(labels)
  return Metric.update(Metric.withAttributes(runsStarted, attributes), 1).pipe(
    Effect.andThen(line("flow.run.started")),
    Effect.annotateLogs({ ...attributes, executionId: labels.executionId })
  )
}

/**
 * Records a lineage's settlement: a count of {@link runsSettled}, its
 * {@link runDuration} when its admission time is known, and the log line
 * `flow.run.settled` (Info when it succeeded, Warn otherwise) with the same
 * fields and `durationMs`.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export const recordSettled = (
  labels: RunLabels & {
    readonly executionId: string
    readonly outcome: Outcome
    readonly code: string
    readonly durationMs?: number | undefined
  }
): Effect.Effect<void> => {
  const attributes = { ...runLabels(labels), outcome: labels.outcome, code: code(labels.code) }
  const durationMs = labels.durationMs === undefined ? undefined : Math.max(0, labels.durationMs)
  return Effect.gen(function*() {
    yield* Metric.update(Metric.withAttributes(runsSettled, attributes), 1)
    if (durationMs !== undefined) {
      yield* Metric.update(
        Metric.withAttributes(runDuration, {
          flow: attributes.flow,
          outcome: attributes.outcome,
          placement: attributes.placement
        }),
        durationMs
      )
    }
    yield* line("flow.run.settled", labels.outcome !== "succeeded")
  }).pipe(
    Effect.annotateLogs({
      ...attributes,
      executionId: labels.executionId,
      ...(durationMs === undefined ? {} : { durationMs })
    })
  )
}

/**
 * Records the wait before a run's first step: {@link runFirstStep}.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export const recordFirstStep = (
  labels: { readonly flow: string; readonly placement: string; readonly delayMs: number }
): Effect.Effect<void> =>
  Metric.update(
    Metric.withAttributes(runFirstStep, { flow: flow(labels.flow), placement: placement(labels.placement) }),
    Math.max(0, labels.delayMs)
  )

/**
 * Records one step attempt that ran its body: {@link steps}, and
 * {@link stepRetries} when it is not the step's first attempt. A failed
 * attempt also counts {@link stepFailures} by its `code` (`failed` when the
 * caller names none) and writes the line `flow.step.failed` (Warn where run
 * lines are Info) with `flow`, `attempt`, `code` and, when given, `runId`.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export const recordStep = (
  labels: {
    readonly flow: string
    readonly attempt: number
    readonly outcome: "succeeded" | "failed" | "interrupted"
    readonly code?: string | undefined
    readonly runId?: string | undefined
  }
): Effect.Effect<void> => {
  const label = flow(labels.flow)
  return Metric.update(Metric.withAttributes(steps, { flow: label, outcome: labels.outcome }), 1).pipe(
    Effect.andThen(
      labels.attempt > 1 ? Metric.update(Metric.withAttributes(stepRetries, { flow: label }), 1) : Effect.void
    ),
    Effect.andThen(Effect.suspend(() => {
      if (labels.outcome !== "failed") return Effect.void
      const failure = code(labels.code ?? "failed")
      return Metric.update(Metric.withAttributes(stepFailures, { flow: label, code: failure }), 1).pipe(
        Effect.andThen(line("flow.step.failed", true)),
        Effect.annotateLogs({
          flow: label,
          attempt: labels.attempt,
          code: failure,
          ...(labels.runId === undefined ? {} : { runId: labels.runId })
        })
      )
    }))
  )
}

/**
 * Records a run parking on a durable wait: {@link waits}.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export const recordWait = (labels: { readonly flow: string; readonly kind: WaitKind }): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(waits, { flow: flow(labels.flow), kind: labels.kind }), 1)

/**
 * Records a durable wait ending as its run resumes: {@link waitDuration}.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export const recordWaitEnded = (
  labels: { readonly flow: string; readonly kind: WaitKind; readonly durationMs: number }
): Effect.Effect<void> =>
  Metric.update(
    Metric.withAttributes(waitDuration, { flow: flow(labels.flow), kind: labels.kind }),
    Math.max(0, labels.durationMs)
  )

/**
 * Records one model call a flow's step made: {@link modelCalls}, the tokens
 * it reported as {@link modelTokens}, and the log line `flow.model.call` with
 * `flow`, `model`, `outcome`, `inputTokens` and `outputTokens`.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export const recordModelCall = (
  labels: {
    readonly flow: string
    readonly model: string
    readonly outcome: string
    readonly inputTokens?: number | undefined
    readonly outputTokens?: number | undefined
  }
): Effect.Effect<void> => {
  const attributes = { flow: flow(labels.flow), model: model(labels.model) }
  // A model step's outcome is one of its closed few (`sealed`, `sealed_error`, `refused`, …).
  const outcome = clean(labels.outcome)
  const tokens = (direction: "input" | "output", value: number | undefined) =>
    value === undefined || value <= 0
      ? Effect.void
      : Metric.update(Metric.withAttributes(modelTokens, { ...attributes, direction }), value)
  return Effect.gen(function*() {
    yield* Metric.update(Metric.withAttributes(modelCalls, { ...attributes, outcome }), 1)
    yield* tokens("input", labels.inputTokens)
    yield* tokens("output", labels.outputTokens)
    yield* line("flow.model.call")
  }).pipe(
    Effect.annotateLogs({
      ...attributes,
      outcome,
      inputTokens: labels.inputTokens ?? 0,
      outputTokens: labels.outputTokens ?? 0
    })
  )
}
