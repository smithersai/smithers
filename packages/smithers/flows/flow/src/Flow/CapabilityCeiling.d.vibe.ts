/** Declared capability ceilings shared by planning and execution.
 * @since 1.0.0
 */
import * as Capability from "@smthrs/capability/Capability";
import * as Context from "effect/Context";
/** Returns only explicitly declared ceilings; omission inherits.
 * @category accessors
 * @since 1.0.0
 */
export declare const capabilityCeilings: (annotations: Context.Context<never>) => ReadonlyArray<ReadonlyArray<string>>;
/** Parses declaration patterns into ceiling groups. Invalid patterns are dropped, so they deny.
 * @category constructors
 * @since 1.0.0
 */
export declare const parseCapabilityCeilings: (groups: ReadonlyArray<ReadonlyArray<string>>) => ReadonlyArray<ReadonlyArray<Capability.CapabilityPattern>>;
/** Applies declaration patterns as an exact conjunction. Invalid patterns deny.
 * @category combinators
 * @since 1.0.0
 */
export declare const attenuateCapabilities: (groups: ReadonlyArray<ReadonlyArray<string>>) => <A, E, R>(effect: import("effect/Effect").Effect<A, E, R>) => import("effect/Effect").Effect<A, E, R>;
/**
 * Intersects two ceilings in their transported form, the groups of pattern text a credential or a message carries:
 * `[]` is unrestricted and a group with no valid pattern denies every capability. The result is normalized exactly as
 * `CapabilitySet.intersect` normalizes its own, so equal authority has one form, and it never allows what either side
 * denies.
 * @category combinators
 * @since 1.0.0
 */
export declare const intersectCeilings: (left: ReadonlyArray<ReadonlyArray<string>>, right: ReadonlyArray<ReadonlyArray<string>>) => ReadonlyArray<ReadonlyArray<string>>;
/**
 * Whether every capability `inner` allows is provably allowed by `outer`, both in transported form
 * (`CapabilitySet.within`). It answers `false` for any containment its syntactic check can't prove, so a `true` never
 * lets `inner` stand for authority `outer` lacks: an unrestricted `inner` is within only an unrestricted `outer`.
 * @category predicates
 * @since 1.0.0
 */
export declare const ceilingWithin: (inner: ReadonlyArray<ReadonlyArray<string>>, outer: ReadonlyArray<ReadonlyArray<string>>) => boolean;
