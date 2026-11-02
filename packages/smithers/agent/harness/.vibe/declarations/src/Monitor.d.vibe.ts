/**
 * Declarative supervisor monitors: what one reading can put in front of the
 * run, and when.
 *
 * A monitor turns one {@link Supervisor.Reading} into a probability `p` and a
 * sentence. A {@link Questioned} monitor adds one boolean question to the
 * supervisor's single Jev call; a {@link Derived} monitor scores answers the
 * supervisor already asks and costs nothing. {@link evaluate} runs at reading
 * time and renders every crossed monitor's text against the reading's own
 * snapshot. {@link gate} runs later, at the recorded steering drain, against
 * the durable {@link Ledger}: it applies each monitor's streak, cooldown and
 * limit and delivers at most one message.
 *
 * Both halves are pure. Nothing here asks Jev, journals, or steers.
 *
 * @since 1.0.0-rc.0
 */
import * as Classifier from "@smthrs/model/Classifier";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AgentEvent from "../../../src/AgentEvent.ts";
import * as Supervisor from "../../../src/Supervisor.ts";
/**
 * What a monitor watches for.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Kind = typeof AgentEvent.MonitorKind.Type;
/**
 * The fields every monitor declares.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Common {
    /** Matches {@link idPattern}; the question id is {@link questionId}. */
    readonly id: string;
    readonly kind: Kind;
    /** Crosses when `p >= at`; in `(0, 1]`. */
    readonly at: number;
    /** Consecutive crossed readings before delivery. */
    readonly consecutive: number;
    /** Frames after a delivery before the next one. */
    readonly cooldownFrames: number;
    /** Deliveries per run. */
    readonly limit: number;
    /** The higher priority takes the one slot. */
    readonly priority: number;
    readonly say: (snapshot: Supervisor.Snapshot, reading: Supervisor.Reading) => string;
}
/**
 * A monitor that adds one boolean question to the supervisor's Jev call.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Questioned extends Common {
    readonly _tag: "Questioned";
    readonly question: Classifier.BooleanQuestion;
    /** Whether the question is asked of this snapshot; always when absent. */
    readonly applies?: (snapshot: Supervisor.Snapshot) => boolean;
}
/**
 * A monitor scored from answers the supervisor already asks.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Derived extends Common {
    readonly _tag: "Derived";
    readonly score: (reading: Supervisor.Reading, snapshot: Supervisor.Snapshot) => number;
}
/**
 * One declared monitor.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Monitor = Questioned | Derived;
/**
 * The fields {@link make} fills from {@link budgets}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Budget = Pick<Common, "at" | "consecutive" | "cooldownFrames" | "limit" | "priority">;
/**
 * A monitor as declared, with its budget optional.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Input = (Omit<Questioned, keyof Budget> | Omit<Derived, keyof Budget>) & Partial<Budget>;
/**
 * The budget each kind starts from.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const budgets: Readonly<Record<Kind, Budget>>;
/**
 * The ids a monitor may take.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const idPattern: RegExp;
/**
 * The classifier question id of one monitor.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const questionId: (id: string) => keyof Supervisor.MonitorQuestions;
/**
 * Declares one monitor, filling any budget field from its kind's
 * {@link budgets}.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const make: (input: Input) => Monitor;
declare const InvalidMonitor_base: Schema.Class<InvalidMonitor, Schema.TaggedStruct<"@smthrs/harness/Monitor/InvalidMonitor", {
    readonly id: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A monitor declaration that cannot be run.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare class InvalidMonitor extends InvalidMonitor_base {
}
type Suppression = typeof AgentEvent.Suppression.Type;
/**
 * Admits a set of host monitors, or names the first one that cannot be run.
 * The ids each reading adds (`skill_*`, `use_jev`) are reserved.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const validate: (monitors: ReadonlyArray<Monitor>) => Effect.Effect<ReadonlyArray<Monitor>, InvalidMonitor>;
/**
 * The supervisor's own nudge as a monitor: it crosses exactly when
 * {@link Supervisor.crosses} does and says {@link Supervisor.nudge}, with no
 * streak, cooldown or limit.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const lint: () => ReadonlyArray<Monitor>;
/**
 * What the `paranoid` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const paranoidText = "Stance: paranoid. Treat your last result as wrong until a printed check shows it.";
/**
 * What the `careful` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const carefulText = "Stance: careful. No destructive or out-of-scope call; ask with ctx.park if unsure.";
/**
 * What the `step_back` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const stepBackText = "Stance: step back. Name the wrong assumption before the next edit.";
/**
 * What the `clarify` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const clarifyText = "Stance: unsure of the task. Restate it in one line and check it against the files.";
/**
 * Stance monitors over the emotions and help the supervisor already reads.
 *
 * `paranoid` scores on a signal the `supervisor` lint does not own: a demand
 * counter increased. A completion the run survived is a bounced one — a
 * standing completion ends the run, so no reading ever follows it — and a
 * bounce is what spends a narrowing, unmoved, unresolved or claim demand, so
 * a frame whose transition is `complete` in the snapshot is the increase.
 * Scoring it on `suspect` instead crossed exactly when the priority-30 lint
 * did, and the mood never won the slot (#2028).
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const moods: () => ReadonlyArray<Monitor>;
/**
 * The built-in monitors: {@link lint} then {@link moods}.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const defaults: () => ReadonlyArray<Monitor>;
/**
 * What the skill monitor for `name` says.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const skillText: (name: string, path: string) => string;
/**
 * One monitor per skill the snapshot offers, asking whether reading it now
 * would change what the run does next. Its id is `skill_` and the name made
 * safe, with a digest of the name after it when two names make the same id.
 * It says only the skill's name and path, never its description.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const skills: (snapshot: Supervisor.Snapshot) => ReadonlyArray<Monitor>;
/**
 * What the `use_jev` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const useJevText = "Judge those items with one jev call, one question per item.";
/**
 * The lint that nudges a run choosing among printed items by hand toward one
 * `jev` call, asked only while the run can call `jev`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const useJev: () => Monitor;
/**
 * The questions one snapshot adds to the supervisor's call, by
 * {@link questionId}: every {@link Questioned} monitor whose `applies` holds.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const questions: (monitors: ReadonlyArray<Monitor>, snapshot: Supervisor.Snapshot) => Supervisor.MonitorQuestions;
/**
 * One monitor's value in one reading.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Row {
    readonly id: string;
    readonly kind: Kind;
    readonly p: number;
    readonly crossed: boolean;
}
/**
 * A crossed monitor's message, rendered against the reading it crossed on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Candidate {
    readonly id: string;
    readonly kind: Kind;
    readonly priority: number;
    readonly p: number;
    readonly text: string;
}
/**
 * What one reading says about every monitor.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Evaluation {
    readonly rows: ReadonlyArray<Row>;
    readonly candidates: ReadonlyArray<Candidate>;
}
/**
 * Scores every monitor against one reading. A {@link Derived} monitor scores
 * itself; a {@link Questioned} monitor reads `values` by monitor id and has no
 * row when it was not asked.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const evaluate: (input: {
    readonly monitors: ReadonlyArray<Monitor>;
    readonly reading: Supervisor.Reading;
    readonly snapshot: Supervisor.Snapshot;
    readonly values: Readonly<Record<string, number>>;
}) => Evaluation;
/**
 * One monitor's durable delivery state.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Entry: Schema.Struct<{
    readonly streak: Schema.Int;
    readonly delivered: Schema.Int;
    readonly lastFrame: Schema.Int;
}>;
/**
 * The decoded form of {@link Entry}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Entry = typeof Entry.Type;
/**
 * Every monitor's delivery state, by monitor id.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Ledger: Schema.$Record<Schema.String, Schema.Struct<{
    readonly streak: Schema.Int;
    readonly delivered: Schema.Int;
    readonly lastFrame: Schema.Int;
}>>;
/**
 * The decoded form of {@link Ledger}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Ledger = typeof Ledger.Type;
/**
 * The state of a monitor with no entry.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const fresh: Entry;
/**
 * What one drain delivers and withholds.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Gated {
    readonly message?: {
        readonly id: string;
        readonly text: string;
    };
    readonly suppressed: ReadonlyArray<{
        readonly id: string;
        readonly reason: Suppression;
    }>;
    readonly ledger: Ledger;
}
/**
 * Decides, at the steering drain, which one crossed monitor is delivered.
 *
 * Each row moves its monitor's streak: up on a crossing, to zero otherwise; a
 * monitor with no row keeps it. Each candidate is then withheld for its
 * `streak`, its `cooldown` since the last delivery, or its `limit`, in that
 * order. Of the rest the highest priority, then the lower id, takes the one
 * slot and the others are withheld for `slot`. A candidate no monitor
 * declares is ignored.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const gate: (input: {
    readonly rows: ReadonlyArray<Row>;
    readonly candidates: ReadonlyArray<Candidate>;
    readonly monitors: ReadonlyArray<Monitor>;
    readonly ledger: Ledger;
    readonly frame: number;
}) => Gated;
export {};
