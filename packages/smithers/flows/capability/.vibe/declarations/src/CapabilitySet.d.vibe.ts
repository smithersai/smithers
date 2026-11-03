/**
 * Monotone capability authority represented as exact intersections of
 * wildcard languages.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Step Keys.md`, and `docs/specs/Specs/Plan.md`.
 *
 * @since 1.0.0-rc.0
 */
import { Effect } from "effect";
import { type Capability, CapabilityPattern } from "../../../src/Capability.ts";
declare const CapabilitySetTypeId: unique symbol;
/**
 * A normalized conjunction of any-of capability-pattern groups.
 *
 * An empty outer array is unrestricted authority. An empty inner group denies
 * every capability.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CapabilitySet {
    readonly [CapabilitySetTypeId]: typeof CapabilitySetTypeId;
    readonly groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>;
}
/**
 * Creates authority described by one any-of group.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const fromPatterns: (patterns: ReadonlyArray<CapabilityPattern>) => CapabilitySet;
/**
 * Empty authority. Its single empty any-of group rejects every capability.
 *
 * @category defaults
 * @since 1.0.0-rc.0
 */
export declare const none: CapabilitySet;
/**
 * Tests whether every group contains a pattern matching the capability.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export declare const allows: (set: CapabilitySet, capability: Capability) => boolean;
/**
 * Intersects two authorities without synthesizing or simplifying globs.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const intersect: (left: CapabilitySet, right: CapabilitySet) => CapabilitySet;
/**
 * Tests structural equality between normalized capability sets.
 *
 * @category equivalence
 * @since 1.0.0-rc.0
 */
export declare const equals: (left: CapabilitySet, right: CapabilitySet) => boolean;
/**
 * Creates authority from normalized or transported groups, normalized exactly
 * as {@link intersect} normalizes its result. Each inner group is an any-of
 * alternative and the groups intersect.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const fromGroups: (groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>) => CapabilitySet;
/**
 * Conservatively proves that every capability `inner` allows is also allowed
 * by `outer`: each group of `outer` covers, by `subsumes`, every pattern of
 * some group of `inner`. It returns `false` for any containment its syntactic
 * checks cannot prove, so a `true` never lets `inner` stand for authority
 * `outer` lacks. Even a `*` pattern rejects some resources an unrestricted set
 * allows (an absolute path with a dot segment), so unrestricted `inner` is
 * within only an unrestricted `outer`.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const within: (inner: CapabilitySet, outer: CapabilitySet) => boolean;
/**
 * Reads the current fiber's capability authority.
 *
 * The underlying service reference is deliberately private. Callers can
 * inspect authority and attenuate it, but cannot replace the ambient service
 * with a wider set.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export declare const current: Effect.Effect<CapabilitySet>;
/**
 * Runs an effect with authority intersected with one additional any-of group.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const attenuate: (patterns: ReadonlyArray<CapabilityPattern>) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
/** Runs with every persisted ceiling, intersecting with current authority.
 * @category combinators
 * @since 1.0.0
 */
export declare const attenuateGroups: (groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
export {};
