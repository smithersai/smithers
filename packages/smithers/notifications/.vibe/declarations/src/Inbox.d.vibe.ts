/**
 * Pure routing and acknowledgement rules for per-person notices.
 *
 * A notice is one person's durable record about one run or one wait. This
 * module decides who gets a notice about a run, who hears about an event on a
 * repository or branch, when a changed notice needs attention again, and how
 * a Read, Dismiss or Hide from any device merges into the stored row. It does
 * no I/O: a host calls it inside the transaction that writes the rows.
 *
 * Acks are integer versions merged with `greatest()`, so two devices that
 * acknowledge the same notice in either order reach the same row.
 *
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * How closely a principal follows a subject.
 *
 * `all` hears about every run, success included, and each notice enters the
 * person's list. `attention` hears about the same runs as a toast while the
 * toast lives, never as a list entry. `muted` hears nothing about other
 * people's runs; it never silences the principal's own run.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Level: Schema.Literals<readonly ["all", "attention", "muted"]>;
/**
 * How closely a principal follows a subject.
 *
 * @category models
 * @since 1.0.0
 */
export type Level = typeof Level.Type;
/**
 * The level a watch has when nobody chose one.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const DEFAULT_LEVEL: Level;
/**
 * A run's state as a notice reads it.
 *
 * `needs_you` means the run waits on its launcher. Every other principal sees
 * that run as `waiting`, because the question is not theirs to answer.
 *
 * @category models
 * @since 1.0.0
 */
export declare const RunState: Schema.Literals<readonly ["working", "waiting", "needs_you", "failed", "done"]>;
/**
 * A run's state as a notice reads it.
 *
 * @category models
 * @since 1.0.0
 */
export type RunState = typeof RunState.Type;
/**
 * One principal following a subject: a run, a flow, a branch or a repository.
 *
 * @category models
 * @since 1.0.0
 */
export interface Watcher {
    readonly principal: string;
    readonly level: Level;
}
/**
 * One person's notice about a run.
 *
 * `mine` is true only for the run's launcher. `quiet` is true when the notice
 * shows as a toast while it lives and never enters the person's list.
 *
 * @category models
 * @since 1.0.0
 */
export interface Delivery {
    readonly recipient: string;
    readonly mine: boolean;
    readonly state: RunState;
    readonly quiet: boolean;
}
/**
 * What {@link route} reads about one run.
 *
 * `watchers` is every watch that covers the run, from every scope: the run,
 * its flow, its branch and its repository. When one principal appears more
 * than once, the first entry decides, so pass the most specific watch first.
 * `mayRead` answers whether a principal may read the run's repository; when it
 * is absent, everyone may.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunFact {
    readonly launcher: string | undefined;
    readonly state: RunState;
    readonly watchers: ReadonlyArray<Watcher>;
    readonly mayRead?: ((principal: string) => boolean) | undefined;
}
/**
 * Who hears about a run in `fact.state`, and how.
 *
 * - The launcher, when present and permitted by mayRead, comes first, with the run's own
 *   state, `mine: true` and `quiet: false`. A muted watch never silences the
 *   launcher's own run, and the launcher's watch entries are otherwise
 *   ignored.
 * - Every other watcher whose first entry is not `muted` and who may read the
 *   run follows, in input order, with `mine: false`. A watcher reads
 *   `needs_you` as `waiting`; every other state passes through. A watcher at
 *   `attention` gets a quiet delivery, and one at `all` does not.
 *
 * Each recipient appears at most once.
 *
 * @example
 * ```ts
 * import { Inbox } from "@smthrs/notifications"
 *
 * Inbox.route({
 *   launcher: "ana",
 *   state: "needs_you",
 *   watchers: [{ principal: "ben", level: "attention" }]
 * })
 * // [
 * //   { recipient: "ana", mine: true, state: "needs_you", quiet: false },
 * //   { recipient: "ben", mine: false, state: "waiting", quiet: true }
 * // ]
 * ```
 *
 * @category routing
 * @since 1.0.0
 */
export declare const route: (fact: RunFact) => ReadonlyArray<Delivery>;
/**
 * Who hears about an event on a subject that is not a run, such as a
 * repository's `main` moving or a new release.
 *
 * Every watcher whose first entry is not `muted` and who may read the subject,
 * each once, in input order. When `mayRead` is absent, everyone may.
 *
 * @category routing
 * @since 1.0.0
 */
export declare const audience: (watchers: ReadonlyArray<Watcher>, mayRead?: (principal: string) => boolean) => ReadonlyArray<string>;
/**
 * Whether a run notice moving from `before` to `after` needs attention again,
 * so its version goes up and it shows again on every device.
 *
 * A new notice (`before` is `undefined`) always raises. A change into
 * `needs_you`, `failed` or `done` raises. Moving between `working` and
 * `waiting`, from `needs_you` back to `working`, or to the same state again
 * does not.
 *
 * @category versions
 * @since 1.0.0
 */
export declare const raises: (before: RunState | undefined, after: RunState) => boolean;
/**
 * What a person does to a notice.
 *
 * `read` records that they opened it. `dismiss` closes it. `hide` removes its
 * toast and keeps its entry and action.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Act: Schema.Literals<readonly ["read", "dismiss", "hide"]>;
/**
 * What a person does to a notice.
 *
 * @category models
 * @since 1.0.0
 */
export type Act = typeof Act.Type;
/**
 * A notice's versions.
 *
 * `version` goes up each time the notice needs attention again. Each act
 * records the version it saw, so an ack for an older version never closes,
 * reads or hides a newer one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Versions {
    readonly version: number;
    readonly readVersion: number;
    readonly dismissedVersion: number;
    readonly hiddenVersion: number;
}
/**
 * The notice with `act` recorded at `version`.
 *
 * The act's field becomes `max(current, min(version, notice.version))`, the
 * same merge as Postgres' `greatest()`: it never passes the notice's own
 * version and never goes back. Every other field is kept, and a call that
 * changes nothing returns `notice` itself. Acks from two devices merge to the
 * same notice in either order.
 *
 * @example
 * ```ts
 * import { Inbox } from "@smthrs/notifications"
 *
 * const notice = { version: 3, readVersion: 1, dismissedVersion: 0, hiddenVersion: 0 }
 * Inbox.ack(notice, "dismiss", 2).dismissedVersion // 2: still open at version 3
 * Inbox.ack(notice, "dismiss", 9).dismissedVersion // 3: capped at the notice's version
 * ```
 *
 * @category versions
 * @since 1.0.0
 */
export declare const ack: <V extends Versions>(notice: V, act: Act, version: number) => V;
/**
 * Whether the notice is still open: nobody dismissed its current version.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const isOpen: (notice: Pick<Versions, "version" | "dismissedVersion">) => boolean;
/**
 * Whether the person has not read the notice's current version.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const isUnread: (notice: Pick<Versions, "version" | "readVersion">) => boolean;
/**
 * Whether the notice's current version is hidden: its toast is gone and its
 * entry stays.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const isHidden: (notice: Pick<Versions, "version" | "hiddenVersion">) => boolean;
