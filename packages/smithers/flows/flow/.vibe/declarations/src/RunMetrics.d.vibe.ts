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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
/**
 * What started a run: a person's button, slash command, view, composer or key; the
 * agent; an API call; an event such as a webhook; a schedule; sync, when a
 * row another device wrote asks this one to act; or another flow.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export declare const doors: readonly ["button", "slash", "view", "composer", "key", "agent", "api", "event", "schedule", "sync", "flow", "unknown"];
/**
 * A door, or `other` for a value outside {@link doors}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Door = (typeof doors)[number] | "other";
/**
 * The kind of actor that started a run. Until run credentials name one, a
 * caller states it, and an unstated one is `unknown`.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export declare const actors: readonly ["person", "agent", "app", "plugin", "unknown"];
/**
 * An actor kind, or `other` for a value outside {@link actors}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Actor = (typeof actors)[number] | "other";
/**
 * Where a run ran: a browser tab's engine, a Cloudflare Durable Object, a
 * sandbox, or a local Node or Bun program.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export declare const placements: readonly ["browser", "cloudflare", "sandbox", "local", "unknown"];
/**
 * A placement, or `other` for a value outside {@link placements}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Placement = (typeof placements)[number] | "other";
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
export declare const outcomes: readonly ["succeeded", "failed", "refused", "cancelled", "lost"];
/**
 * The value form of {@link outcomes}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type Outcome = (typeof outcomes)[number];
/**
 * What a durable wait waited on: a timer, a signal or event, an approval, a
 * quota, a person's answer, or anything else.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export declare const waitKinds: readonly ["timer", "signal", "approval", "quota", "human", "other"];
/**
 * The value form of {@link waitKinds}.
 *
 * @category vocabulary
 * @since 1.0.0-rc.17
 */
export type WaitKind = (typeof waitKinds)[number];
/**
 * The door a value names: itself when {@link doors} lists it, `unknown` when
 * absent, otherwise `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const door: (value: string | undefined) => Door;
/**
 * The actor kind a value names: itself when {@link actors} lists it, `unknown`
 * when absent, otherwise `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const actor: (value: string | undefined) => Actor;
/**
 * The placement a value names: itself when {@link placements} lists it,
 * `unknown` when absent, otherwise `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const placement: (value: string | undefined) => Placement;
/**
 * The wait kind a parked run's reason reads as: `event` and `signal` are a
 * `signal`, and a reason {@link waitKinds} doesn't list is `other`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const waitKind: (reason: string) => WaitKind;
/**
 * Who and what started a run, as the caller says: the {@link Door} and the
 * {@link Actor} kind. Never a person's identity.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Origin {
    readonly door: string;
    readonly actor: string;
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
export declare const CurrentOrigin: Context.Reference<Origin>;
/**
 * Runs `effect` with `origin` as {@link CurrentOrigin}, so a run it starts is
 * counted under that door and actor.
 *
 * @category context
 * @since 1.0.0-rc.17
 */
export declare const withOrigin: {
    (origin: Origin): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <A, E, R>(effect: Effect.Effect<A, E, R>, origin: Origin): Effect.Effect<A, E, R>;
};
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
export declare const LineLevel: Context.Reference<"Debug" | "Info">;
/**
 * Writes the usage log lines at Info, for a host whose logs are its telemetry.
 *
 * @category context
 * @since 1.0.0-rc.17
 */
export declare const layerInfoLines: Layer.Layer<never>;
/**
 * A bounded set of label values: each value is cleaned to a short identifier,
 * and once `limit` distinct values were seen, every new one reads `other`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Labels {
    readonly of: (value: string) => string;
    /** How many distinct values it holds. */
    readonly size: () => number;
}
/**
 * A label value as an identifier: letters, digits and `_ . / : @ -` kept,
 * anything else `_`, cut to 96 characters; an empty value is `unknown`.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const clean: (value: string) => string;
/**
 * Makes a {@link Labels} that keeps at most `limit` distinct values.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export declare const makeLabels: (limit: number) => Labels;
/**
 * The most distinct flow tags one process labels; later ones read `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export declare const maxFlows = 200;
/**
 * The most distinct model ids one process labels.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export declare const maxModels = 50;
/**
 * The most distinct failure codes one process labels.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export declare const maxCodes = 100;
/**
 * A flow's tag as a label, capped at {@link maxFlows} per process.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const flow: (tag: string) => string;
/**
 * A model id as a label, capped at {@link maxModels} per process.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const model: (id: string) => string;
/**
 * A failure code as a label, capped at {@link maxCodes} per process; `none`
 * for no failure.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const code: (value: string) => string;
/**
 * How a run that ended with `exit` settled, and the code of its failure:
 * `none` on success, an interpreter refusal's code (`plan_changed`,
 * `payload_changed`), a typed failure's `code` or tag, a defect's tag or name
 * (`defect` when it has none), or `interrupted`. Never a message.
 *
 * @category attributes
 * @since 1.0.0-rc.17
 */
export declare const settlement: (exit: Exit.Exit<unknown, unknown>) => {
    readonly outcome: Outcome;
    readonly code: string;
};
/**
 * Milliseconds bucket boundaries for durations: 10 ms to a day.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export declare const durationBoundaries: ReadonlyArray<number>;
/**
 * Runs admitted, by `flow`, `door`, `actor` and `placement`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const runsStarted: Metric.Counter<number>;
/**
 * Run lineages settled, by `flow`, `outcome`, `code`, `door`, `actor` and
 * `placement`. A round that hands off to the next round is not a settlement.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const runsSettled: Metric.Counter<number>;
/**
 * From a run's admission to its settlement, in milliseconds, by `flow`,
 * `outcome` and `placement`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const runDuration: Metric.Histogram<number>;
/**
 * From a run's admission to the engine first starting it, when its first step
 * can run, in milliseconds, by `flow` and `placement`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const runFirstStep: Metric.Histogram<number>;
/**
 * Step attempts that ran their body, by `flow` and `outcome` (`succeeded`,
 * `failed`, `interrupted`). A step answered from its record is not counted.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const steps: Metric.Counter<number>;
/**
 * Step attempts that failed, by `flow` and `code`: the failure's code (a
 * typed failure's `code` or tag, a defect's tag or name), never its message.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const stepFailures: Metric.Counter<number>;
/**
 * Step attempts after a step's first, by `flow`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const stepRetries: Metric.Counter<number>;
/**
 * Durable waits a run parked on, by `flow` and `kind`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const waits: Metric.Counter<number>;
/**
 * How long a durable wait lasted, from the park to the run resuming, in
 * milliseconds, by `flow` and `kind`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const waitDuration: Metric.Histogram<number>;
/**
 * Model calls a flow's steps made, by `flow`, `model` and `outcome`. A step
 * answered from its record calls no model and is not counted.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const modelCalls: Metric.Counter<number>;
/**
 * Tokens those calls reported, by `flow`, `model` and `direction` (`input`,
 * `output`).
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const modelTokens: Metric.Counter<number>;
/**
 * Where and by whom a run was started, as its records label it.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RunLabels {
    readonly flow: string;
    readonly door: string;
    readonly actor: string;
    readonly placement: string;
}
/**
 * Records a run's admission: a count of {@link runsStarted} and the log line
 * `flow.run.started`, with its execution id.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export declare const recordStarted: (labels: RunLabels & {
    readonly executionId: string;
}) => Effect.Effect<void>;
/**
 * Records a lineage's settlement: a count of {@link runsSettled}, its
 * {@link runDuration} when its admission time is known, and the log line
 * `flow.run.settled` (Info when it succeeded, Warn otherwise) with the same
 * fields and `durationMs`.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export declare const recordSettled: (labels: RunLabels & {
    readonly executionId: string;
    readonly outcome: Outcome;
    readonly code: string;
    readonly durationMs?: number | undefined;
}) => Effect.Effect<void>;
/**
 * Records the wait before a run's first step: {@link runFirstStep}.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export declare const recordFirstStep: (labels: {
    readonly flow: string;
    readonly placement: string;
    readonly delayMs: number;
}) => Effect.Effect<void>;
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
export declare const recordStep: (labels: {
    readonly flow: string;
    readonly attempt: number;
    readonly outcome: "succeeded" | "failed" | "interrupted";
    readonly code?: string | undefined;
    readonly runId?: string | undefined;
}) => Effect.Effect<void>;
/**
 * Records a run parking on a durable wait: {@link waits}.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export declare const recordWait: (labels: {
    readonly flow: string;
    readonly kind: WaitKind;
}) => Effect.Effect<void>;
/**
 * Records a durable wait ending as its run resumes: {@link waitDuration}.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export declare const recordWaitEnded: (labels: {
    readonly flow: string;
    readonly kind: WaitKind;
    readonly durationMs: number;
}) => Effect.Effect<void>;
/**
 * Records one model call a flow's step made: {@link modelCalls}, the tokens
 * it reported as {@link modelTokens}, and the log line `flow.model.call` with
 * `flow`, `model`, `outcome`, `inputTokens` and `outputTokens`.
 *
 * @category recording
 * @since 1.0.0-rc.17
 */
export declare const recordModelCall: (labels: {
    readonly flow: string;
    readonly model: string;
    readonly outcome: string;
    readonly inputTokens?: number | undefined;
    readonly outputTokens?: number | undefined;
}) => Effect.Effect<void>;
