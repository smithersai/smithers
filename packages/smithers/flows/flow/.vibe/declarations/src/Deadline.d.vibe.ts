/**
 * The wall-clock bound one run of a flow settles by.
 *
 * A deadline counts from the run's FIRST start, which is journaled, so it
 * survives park, resume and process death: a restarted engine honors the
 * original deadline instead of starting a new one. A trampoline lineage is one
 * run, so its rounds share one deadline: the round that hands off stamps the
 * lineage's start and bound on the {@link module:Result.Handoff}, and the next
 * round runs under that stamp rather than starting a clock of its own. Like
 * `maxRounds`, the bound belongs to the lineage originator; a handoff target
 * cannot reset or replace it.
 *
 * The engine applies {@link bound} to every execution of a flow that declares
 * `Flow.make(tag, { deadline })`. A control plane applies it inside a run body
 * to bound a run by an approved envelope's deadline. Both settle an expired
 * run with the same {@link module:DeadlineExceeded.DeadlineExceeded} defect.
 *
 * @since 1.0.0
 */
import type { Crypto } from "@smthrs/crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { type LineageDeadline } from "./Flow/Result.vibe";
import { FlowInstance } from "./FlowRuntime/FlowInstance.vibe";
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.vibe";
/**
 * Starts the current execution's deadline: the lineage deadline this round
 * inherited from a handoff, or `deadline` counted from the execution's
 * journaled first start, or from `startedAtMs` when the host supplies a
 * durable start of its own. Answers `undefined` when neither applies, which is
 * an unbounded execution.
 *
 * **Details**
 *
 * The first start is a sealed action, so every later drive of the execution,
 * on this engine or one that resumes it after a restart, reads the same
 * origin. A durable clock is armed at the deadline so a parked execution is
 * driven again when it passes; the clock keeps the due time it was first armed
 * with, so arming it on every drive is idempotent.
 *
 * **Gotchas**
 *
 * Start at most one deadline per execution, before any other dispatch that a
 * replay must line up with: the origin and the clock are addressed by fixed
 * names within the execution.
 *
 * A deadline that is not a positive finite duration, a `startedAtMs` that is
 * not finite, or a bound that would expire after epoch millisecond
 * `Number.MAX_SAFE_INTEGER` dies with a `RangeError`: a durable store records
 * the clock's due time as a safe integer.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const start: (options: {
    /** The flow the refusal names. */
    readonly flowName: string;
    /** The bound; a positive finite duration. Absent means unbounded. */
    readonly deadline?: Duration.Input | undefined;
    /**
     * Where the bound counts from, when the host already holds a durable
     * start of its own, such as the time a control plane accepted the run.
     * Absent, the execution's first start is journaled and read back.
     */
    readonly startedAtMs?: number | undefined;
}) => Effect.Effect<LineageDeadline | undefined, never, FlowRuntime | FlowInstance | Crypto.Crypto>;
/**
 * The whole milliseconds left before `deadline` passes, as the durable clock
 * row stores its due time; zero or less once it has passed.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const remainingMs: (deadline: LineageDeadline) => Effect.Effect<number>;
/**
 * Runs `body` within a started deadline.
 *
 * A body that starts at or past the deadline settles at once, and one that
 * starts before it races the time remaining in this fiber, so a running
 * execution is stopped too. Both settle with the same `DeadlineExceeded`
 * defect. The race is `raceFirst`: a body that parks exits first, so parking
 * still parks. A round that hands off stamps the deadline on its handoff, so
 * the next round of the lineage runs under it. An `undefined` deadline runs
 * `body` unbounded.
 *
 * @category combinators
 * @since 1.0.0
 */
export declare const within: (deadline: LineageDeadline | undefined, flowName: string) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | FlowInstance>;
/**
 * Bounds the current execution by `deadline`, counted from its journaled first
 * start, or by the lineage deadline this round inherited from a handoff:
 * {@link start}, then {@link within}.
 *
 * A round that inherited a lineage deadline runs under it whatever it
 * declares, so every round of a lineage expires at the originator's time. With
 * no inherited deadline and `deadline` absent, the body runs unbounded.
 *
 * @category combinators
 * @since 1.0.0
 */
export declare const bound: (options: {
    /** The flow the refusal names. */
    readonly flowName: string;
    /** The bound; a positive finite duration. Absent means unbounded. */
    readonly deadline?: Duration.Input | undefined;
    /** Where the bound counts from; see {@link start}. */
    readonly startedAtMs?: number | undefined;
}) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | FlowRuntime | FlowInstance | Crypto.Crypto>;
