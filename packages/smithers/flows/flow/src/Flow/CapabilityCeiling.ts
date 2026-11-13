/** Declared capability ceilings shared by planning and execution.
 * @since 1.0.0
 */

import { Capability, CapabilitySet } from "@smthrs/capability"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import { Capabilities } from "./Annotations.ts"

/** Returns only explicitly declared ceilings; omission inherits.
 * @category accessors
 * @since 1.0.0
 */
export const capabilityCeilings = (annotations: Context.Context<never>): ReadonlyArray<ReadonlyArray<string>> =>
  annotations.mapUnsafe.has(Capabilities.key) ? [Context.get(annotations, Capabilities)] : []

/** Parses declaration patterns into ceiling groups. Invalid patterns are dropped, so they deny.
 * @category constructors
 * @since 1.0.0
 */
export const parseCapabilityCeilings = (
  groups: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<Capability.CapabilityPattern>> =>
  groups.map((group) =>
    group.flatMap((text) => {
      const parsed = Capability.parsePattern(text)
      return Option.isSome(parsed) ? [parsed.value] : []
    })
  )

/** Applies declaration patterns as an exact conjunction. Invalid patterns deny.
 * @category combinators
 * @since 1.0.0
 */
export const attenuateCapabilities = (groups: ReadonlyArray<ReadonlyArray<string>>) =>
  CapabilitySet.attenuateGroups(parseCapabilityCeilings(groups))

/** The authority a transported ceiling describes: its groups parsed, invalid patterns dropped so they deny. */
const authorityOf = (groups: ReadonlyArray<ReadonlyArray<string>>) =>
  CapabilitySet.fromGroups(parseCapabilityCeilings(groups))

/**
 * Intersects two ceilings in their transported form, the groups of pattern text a credential or a message carries:
 * `[]` is unrestricted and a group with no valid pattern denies every capability. The result is normalized exactly as
 * `CapabilitySet.intersect` normalizes its own, so equal authority has one form, and it never allows what either side
 * denies.
 * @category combinators
 * @since 1.0.0
 */
export const intersectCeilings = (
  left: ReadonlyArray<ReadonlyArray<string>>,
  right: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> =>
  CapabilitySet.intersect(authorityOf(left), authorityOf(right)).groups.map((group) => group.map(Capability.format))

/**
 * Whether every capability `inner` allows is provably allowed by `outer`, both in transported form
 * (`CapabilitySet.within`). It answers `false` for any containment its syntactic check can't prove, so a `true` never
 * lets `inner` stand for authority `outer` lacks: an unrestricted `inner` is within only an unrestricted `outer`.
 * @category predicates
 * @since 1.0.0
 */
export const ceilingWithin = (
  inner: ReadonlyArray<ReadonlyArray<string>>,
  outer: ReadonlyArray<ReadonlyArray<string>>
): boolean => CapabilitySet.within(authorityOf(inner), authorityOf(outer))
