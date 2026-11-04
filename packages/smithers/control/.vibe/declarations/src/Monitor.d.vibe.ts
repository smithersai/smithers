/**
 * Run health over the control plane: what a run's state means, and what to do
 * about it.
 *
 * A control plane answers "what is this run doing". A monitor answers the
 * question after it — "is that all right, and if not, what now" — and the two
 * are deliberately separate modules. {@link classify} is a pure function of
 * one observation, so the vocabulary an operator reads on a dashboard is the
 * same one a heal loop branches on and the same one a test can enumerate.
 * {@link run} is the loop that beats over `Control` and journals what it saw.
 *
 * The classification is decided from durable evidence only: the run summary
 * the control plane projects, and the journal entries `watch` replays. Nothing
 * here reads an in-process fiber, which is what makes a monitor able to watch
 * a run in another process at all.
 *
 * @since 0.1.0
 */
import { Journal } from "@smthrs/journal";
import { Effect } from "effect";
import { Control } from "../../../src/Control.ts";
import type { ControlError } from "../../../src/ControlError.ts";
import type { ControlEvent, Receipt, RunId, RunSummary } from "../../../src/ControlSchema.ts";
import * as SubjectHealth from "./Health.vibe";
/**
 * The journal event type the engine records when an action attempt starts.
 *
 * Named as a string rather than imported, exactly as in `Lineage`: a monitor
 * reads journals, not engines.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const attemptStartedEventType = "flows.engine.attempt-started";
/**
 * The journal event type the engine records when an action attempt settles.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const attemptFinishedEventType = "flows.engine.attempt-finished";
/**
 * The journal event type one monitor beat is recorded under.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const beatEventType = "control.monitor.beat";
/**
 * The journal event type one applied remedy is recorded under.
 *
 * A beat and a heal are two records because they are two facts, and only one
 * of them is true before the remedy runs. A single record carrying `healed`
 * has to be written either before the remedy — leaving durable evidence of a
 * heal that a crash one instruction later never performed — or after it, which
 * loses the evidence of what a monitor decided when the remedy is what killed
 * it. Splitting them keeps both.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const healedEventType = "control.monitor.healed";
/**
 * What a run looks like to a monitor.
 *
 * `healthy` covers both "moving" and "finished": a completed run needs nothing
 * done to it, and neither does one that is making progress. The other six name
 * a specific thing that is wrong, because a heal that cannot tell them apart
 * would resume a run that is waiting for a human.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Health: import("effect/Schema").Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
/**
 * What a run looks like to a monitor.
 *
 * @category models
 * @since 0.1.0
 */
export type Health = typeof Health.Type;
/**
 * Everything one classification is decided from.
 *
 * `events` is the run's journal as `watch` projects it, oldest first.
 * `beatsWithoutProgress` counts consecutive beats that added no entry, and
 * `stallBeats` is how many of those make a stall. Splitting the count from the
 * threshold is what lets the same pure function serve a monitor that beats
 * every second and one that beats every hour.
 *
 * @category models
 * @since 0.1.0
 */
export interface Observation {
    /** The run's projection, or nothing when the control plane has no such run. */
    readonly summary?: RunSummary | undefined;
    readonly events: ReadonlyArray<ControlEvent>;
    readonly beatsWithoutProgress: number;
    readonly stallBeats: number;
    /**
     * The trampoline round at which a lineage stops being a loop and starts
     * being a runaway. A run past it is looping without converging.
     */
    readonly roundBound?: number | undefined;
    /** Fresh, explicitly reported semantic work; never inferred from bytes or monitor events. */
    readonly semanticProgress?: boolean | undefined;
}
/**
 * Decides what a run's state means.
 *
 * The order is the order an operator would read it in, and each rule earns its
 * place by naming a different response:
 *
 * | Condition | Health | Because |
 * | --- | --- | --- |
 * | No summary | `unknown` | Nothing to say, and nothing to do. |
 * | `failed` | `failing` | The run itself reported the failure. |
 * | `completed`, `cancelled` | `healthy` | A finished run needs nothing. |
 * | `waiting-approval`, or parked on `approval` | `awaiting-human` | A human owes it an answer; no machine can supply one. |
 * | Parked with no waiting reason | `awaiting-human` | Only an operator's own park writes no waiting reason, so a person stopped it and a person restarts it. |
 * | `roundOrdinal` at or past the bound | `runaway-loop` | The lineage is looping without converging. |
 * | The last settled attempt failed | `failing` | The run is still alive but its work is not landing. |
 * | No progress for `stallBeats`, an attempt open | `wedged-node` | One attempt started and never settled: the work is stuck, not the run. |
 * | No progress for `stallBeats` | `stalled` | Nothing is happening and nothing is in flight. |
 * | Anything else | `healthy` | Entries are still arriving. |
 *
 * `awaiting-human` deliberately outranks `failing`: a run parked for approval
 * after a failed attempt is waiting for a person, and resuming or cancelling
 * it would take the decision away from them.
 *
 * A park with no reason is the same case. The engine names every park it makes
 * — `event`, `approval`, `timer`, `quota`, `released` — so a parked run whose
 * `waitingReason` is absent was parked by an operator through
 * `ControlRuntime.writeStatus`. Calling that a stall and resuming it would undo
 * a deliberate act, which is the worst thing an unattended heal loop can do.
 *
 * @param observation what the beat saw
 * @category projections
 * @since 0.1.0
 */
export declare const classify: (observation: Observation) => Health;
/**
 * What a monitor does about one unhealthy run.
 *
 * @category models
 * @since 0.1.0
 */
export type Remedy = "resume" | "cancel" | "none";
/**
 * The remedy a health warrants, before `autoHeal` decides whether to apply it.
 *
 * A stalled or wedged run is one nobody is driving, and a resume claims it. A
 * failing or runaway run is one that will not get better by being driven
 * harder. Everything else is left alone.
 *
 * @param health what the beat classified
 * @category projections
 * @since 0.1.0
 */
export declare const remedyFor: (health: Health) => Remedy;
/**
 * One beat of a monitor.
 *
 * @category models
 * @since 0.1.0
 */
export interface Beat {
    /** Which beat this was, counting from zero. */
    readonly beat: number;
    readonly health: Health;
    /** The newest journal sequence the run had, ignoring the monitor's own records. */
    readonly sequence: number;
    /**
     * The remedy that ran and returned, absent when none did.
     *
     * Present only after the heal succeeded, which is also when
     * `control.monitor.healed` is journaled. A beat that decided on a remedy the
     * monitor never got to apply reports nothing here.
     */
    readonly healed?: Remedy | undefined;
    /** The receipt the remedy returned, absent when none was applied. */
    readonly receipt?: Receipt | undefined;
}
/**
 * What a monitor found.
 *
 * @category models
 * @since 0.1.0
 */
export interface Report {
    readonly runId: RunId;
    readonly beats: ReadonlyArray<Beat>;
    /** The last beat's health, or `unknown` when no beat ran. */
    readonly health: Health;
}
/**
 * How a monitor beats.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    readonly runId: RunId;
    /** Optional configured observational checker; checker results never authorize a remedy. */
    readonly healthCheck?: SubjectHealth.ResolvedCheck | undefined;
    /** Shared host admission limit around probes. */
    readonly withProbePermit?: (<A>(effect: Effect.Effect<A>) => Effect.Effect<A>) | undefined;
    /** Bounded retained beat history for long-lived host monitoring. */
    readonly retainBeats?: number | undefined;
    /** Hosts with structured status observations omit redundant legacy heartbeat records. */
    readonly recordBeats?: boolean | undefined;
    /**
     * Who is watching. Defaults to `default`.
     *
     * It reaches the journal twice: as the source of every record this monitor
     * writes, and as `monitorId` in each payload. Two monitors pointed at one
     * run both beat and both remedy — nothing on the control plane leases a run
     * to one watcher — so the identity is what makes their evidence tellable
     * apart, and what keeps their remedies on separate idempotency keys.
     */
    readonly monitorId?: string | undefined;
    /** How long to wait between beats. Defaults to one second. */
    readonly intervalMs?: number | undefined;
    /** How many beats to take before reporting. Defaults to ten. */
    readonly maxChecks?: number | undefined;
    /** How many beats without progress make a stall. Defaults to three. */
    readonly stallBeats?: number | undefined;
    /** The round at which a trampoline is a runaway. Defaults to 32. */
    readonly roundBound?: number | undefined;
    /** Which healths the monitor is allowed to act on. Defaults to none. */
    readonly autoHeal?: ReadonlyArray<Health> | undefined;
    /**
     * What to do about an unhealthy run. Defaults to `Control.resume` and
     * `Control.cancel` per {@link remedyFor}.
     *
     * A heal that fails does not abort the monitor: the failure is logged, the
     * beat is recorded without `healed` or `receipt`, and the loop moves to the
     * next beat, where the stall evidence still stands and the remedy is
     * retried under that beat's own idempotency key.
     */
    readonly heal?: (input: {
        readonly runId: RunId;
        readonly health: Health;
        readonly remedy: Remedy;
        readonly beat: number;
    }) => Effect.Effect<Receipt, ControlError>;
}
/**
 * Watches one run and, when told to, heals it.
 *
 * The loop stops early on a terminal run, because a finished run has nothing
 * left to observe and beating at it would fill its journal with heartbeats.
 * Otherwise it takes `maxChecks` beats and reports what it saw.
 *
 * Every beat is journaled as `control.monitor.beat` before any remedy is
 * applied, carrying the `remedy` it is about to attempt, so a monitor that
 * crashes mid-heal leaves the evidence of what it decided. The remedy itself
 * is journaled separately as `control.monitor.healed`, and only once the heal
 * returned a receipt: a heal that failed, or a process that died running one,
 * must not leave a durable record saying the run was healed.
 *
 * `autoHeal` is empty by default. A monitor that healed by default would be a
 * monitor that cancels a run the first time it looks at one, which is the
 * wrong default for a thing an operator points at production.
 *
 * Fails with `InvalidInput` before the first beat when `intervalMs` is
 * negative or not finite, `maxChecks` is negative or `NaN`, or `stallBeats`,
 * `roundBound` or `retainBeats` is not a positive integer.
 *
 * Nothing here leases the run. Two monitors on one run both beat and both
 * remedy, so a remedy has to be idempotent on the control plane — which the
 * two defaults are, through `Control.resume` and `Control.cancel`
 * idempotency keys that name the monitor, the run, and the beat. A custom
 * `heal` owes the same property.
 *
 * @param options how to beat and what to heal
 * @category constructors
 * @since 0.1.0
 */
export declare const run: (options: Options) => Effect.Effect<Report, ControlError, Control | Journal.Journal>;
/** Observer and notification bookkeeping is never execution progress.
 * @category predicates
 * @since 1.0.0
 */
export declare const isBookkeepingEvent: (kind: string) => boolean;
