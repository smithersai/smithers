/**
 * What `apply` does when work conflicts with its target.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import { type Conflicted, Merged, MergeError } from "./Outcome.vibe";
import type { Repository } from "./Repository.vibe";
/**
 * A merge strategy: given the conflicted change `apply` recorded, answer the
 * outcome to report, or fail.
 *
 * `apply` always lands the work first, so a strategy starts from a change
 * that exists and loses nothing; it decides only what happens next.
 *
 * @category models
 * @since 1.0.0
 */
export interface Strategy<E = never, R = never> {
    readonly onConflict: (conflicted: Conflicted, repository: Repository) => Effect.Effect<Merged | Conflicted, E | MergeError, R>;
}
/**
 * The default: keep the conflicted change and report it, as `jj rebase` does.
 * Its files carry jj's conflict markers until someone resolves them.
 *
 * @category strategies
 * @since 1.0.0
 */
export declare const recordConflicts: Strategy;
/**
 * Abandon the conflicted change and fail with a `conflict` {@link MergeError}
 * naming its paths. The work itself stays wherever the caller keeps it, in
 * the journal for an action's result, so applying again later is possible.
 *
 * @category strategies
 * @since 1.0.0
 */
export declare const failOnConflict: Strategy;
/**
 * Hand the conflicted change to `resolver`, then verify what it produced.
 *
 * The resolver receives the conflicted change (an agent may edit it in a
 * workspace and squash, or replace it) and answers a jj revision holding the
 * resolution. That revision must name exactly one commit that descends from
 * the change's target, and neither it nor anything between the target and it
 * may hold a conflict; otherwise the strategy fails with
 * `resolution_rejected` and the conflicted change is left as it is.
 *
 * @category strategies
 * @since 1.0.0
 */
export declare const resolveWith: <E, R>(resolver: (conflicted: Conflicted, repository: Repository) => Effect.Effect<{
    readonly change: string;
}, E, R>) => Strategy<E, R>;
