/**
 * Monotone capability authority represented as exact intersections of
 * wildcard languages.
 *
 * Defense-in-depth enforcement against ambient ceiling forgery and stripping:
 * 1. Value integrity: every {@link CapabilitySet} is deeply frozen and
 *    authenticated in a module-private `WeakMap` (unbranded `{ groups: [] }`,
 *    forged `Symbol.for` brands, stolen symbols, and `Proxy` wrappers fail
 *    closed).
 * 2. Unforgeable ambient ceiling: the ambient `Context` slot is keyed by a
 *    module-private `Symbol` (never a public string or `Symbol.for`) and holds
 *    an opaque `CeilingSeal` authenticated in a separate module-private
 *    `WeakMap`. Tampering with the slot — including replacing it with
 *    `CapabilitySet.fromGroups([])`, `{ groups: [] }`, `undefined`, or `null`
 *    via `ctx.mapUnsafe` — fails closed to {@link none}.
 * 3. Active fiber monotonic stack: while `attenuate` executes on a fiber, a
 *    private `WeakMap` tracks its active ceiling frames (and pre-existing
 *    children so siblings forked earlier are never retroactively narrowed),
 *    defeating `Context.pick`, `Context.omit`, `Effect.setContext`, and
 *    `fiber.setContext` stripping on the fiber and its forked descendants.
 * 4. Closure-bound service attenuation: `attenuate` invokes the monotone
 *    non-widening attenuation protocol on compliant services in `Context`
 *    (such as `GrantStore`), binding the ceiling into service closures so even
 *    `Effect.forkDetach` + `Context.pick` cannot escape the attenuated service.
 *
 * @since 1.0.0-rc.0
 */

import { Context, Effect } from "effect"
import { type Capability, CapabilityPattern, matches, subsumes } from "./Capability.ts"

const CapabilitySetTypeId: unique symbol = Symbol("@smthrs/capability/CapabilitySet")

/**
 * A normalized conjunction of any-of capability-pattern groups.
 *
 * An empty outer array is unrestricted authority. An empty inner group denies
 * every capability. Only values minted by this module carry authority; any
 * other value fails closed.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CapabilitySet {
  readonly [CapabilitySetTypeId]: typeof CapabilitySetTypeId
  readonly groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
}

const verifiedGroups = new WeakMap<object, ReadonlyArray<ReadonlyArray<CapabilityPattern>>>()

const readVerifiedGroups = (
  set: CapabilitySet
): ReadonlyArray<ReadonlyArray<CapabilityPattern>> | undefined =>
  typeof set === "object" && set !== null ? verifiedGroups.get(set) : undefined

const comparePattern = (left: CapabilityPattern, right: CapabilityPattern): number =>
  left.action < right.action ?
    -1 :
    left.action > right.action ?
    1 :
    left.resource < right.resource ?
    -1 :
    left.resource > right.resource ?
    1 :
    0

const compareGroup = (
  left: ReadonlyArray<CapabilityPattern>,
  right: ReadonlyArray<CapabilityPattern>
): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const order = comparePattern(left[index]!, right[index]!)
    if (order !== 0) {
      return order
    }
  }
  return left.length - right.length
}

const snapshotPattern = (pattern: CapabilityPattern): CapabilityPattern => {
  const action = pattern.action
  const resource = pattern.resource
  return Object.freeze(new CapabilityPattern({ action, resource }))
}

const normalizeGroup = (
  patterns: ReadonlyArray<CapabilityPattern>
): ReadonlyArray<CapabilityPattern> => {
  if (!Array.isArray(patterns)) {
    throw new TypeError("Expected an array of capability patterns")
  }
  const copied: Array<CapabilityPattern> = []
  for (let index = 0; index < patterns.length; index += 1) {
    copied.push(snapshotPattern(patterns[index]))
  }
  copied.sort(comparePattern)
  const normalized: Array<CapabilityPattern> = []
  for (let index = 0; index < copied.length; index += 1) {
    const pattern = copied[index]!
    const previous = normalized.at(-1)
    if (previous === undefined || comparePattern(previous, pattern) !== 0) {
      normalized.push(pattern)
    }
  }
  return Object.freeze(normalized)
}

const fromNormalizedGroups = (
  groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
): CapabilitySet => {
  const frozenGroups = Object.freeze(groups.slice())
  const set: CapabilitySet = {
    [CapabilitySetTypeId]: CapabilitySetTypeId,
    groups: frozenGroups
  }
  Object.freeze(set)
  verifiedGroups.set(set, frozenGroups)
  return set
}

const make = (
  groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
): CapabilitySet => {
  if (!Array.isArray(groups)) {
    throw new TypeError("Expected an array of capability groups")
  }
  const sorted: Array<ReadonlyArray<CapabilityPattern>> = []
  for (let index = 0; index < groups.length; index += 1) {
    sorted.push(normalizeGroup(groups[index]))
  }
  sorted.sort(compareGroup)
  if (sorted.some((group) => group.length === 0)) {
    return fromNormalizedGroups([Object.freeze([])])
  }

  const normalized: Array<ReadonlyArray<CapabilityPattern>> = []
  for (let index = 0; index < sorted.length; index += 1) {
    const group = sorted[index]!
    const previous = normalized.at(-1)
    if (previous === undefined || compareGroup(previous, group) !== 0) {
      normalized.push(group)
    }
  }
  return fromNormalizedGroups(normalized)
}

/**
 * Creates authority described by one any-of group.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const fromPatterns = (
  patterns: ReadonlyArray<CapabilityPattern>
): CapabilitySet => make([patterns])

const unrestricted: CapabilitySet = make([])

/**
 * Empty authority. Its single empty any-of group rejects every capability.
 *
 * @category defaults
 * @since 1.0.0-rc.0
 */
export const none: CapabilitySet = make([[]])

/**
 * Tests whether every group contains a pattern matching the capability.
 *
 * Fails closed (`false`) if `set` was not produced by this module's
 * constructors.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const allows = (
  set: CapabilitySet,
  capability: Capability
): boolean => {
  const groups = readVerifiedGroups(set)
  if (groups === undefined) {
    return false
  }
  return groups.every((group) => group.some((pattern) => matches(pattern, capability)))
}

/**
 * Tests structural equality between normalized capability sets.
 *
 * Returns `false` if either operand is unverified.
 *
 * @category equivalence
 * @since 1.0.0-rc.0
 */
export const equals = (
  left: CapabilitySet,
  right: CapabilitySet
): boolean => {
  const leftGroups = readVerifiedGroups(left)
  const rightGroups = readVerifiedGroups(right)
  if (leftGroups === undefined || rightGroups === undefined) {
    return false
  }
  if (leftGroups.length !== rightGroups.length) {
    return false
  }
  for (let index = 0; index < leftGroups.length; index += 1) {
    if (compareGroup(leftGroups[index]!, rightGroups[index]!) !== 0) {
      return false
    }
  }
  return true
}

/**
 * Intersects two authorities without synthesizing or simplifying globs.
 *
 * Fails closed to {@link none} if either operand is unverified. Preserves
 * reference identity when one operand already equals the intersection.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const intersect = (
  left: CapabilitySet,
  right: CapabilitySet
): CapabilitySet => {
  const leftGroups = readVerifiedGroups(left)
  const rightGroups = readVerifiedGroups(right)
  if (leftGroups === undefined || rightGroups === undefined) {
    return none
  }
  if (left === right || rightGroups.length === 0) {
    return left
  }
  if (leftGroups.length === 0) {
    return right
  }
  const result = make([...leftGroups, ...rightGroups])
  return equals(result, left) ? left : equals(result, right) ? right : result
}

/**
 * Creates authority from normalized or transported groups, normalized exactly
 * as {@link intersect} normalizes its result. Each inner group is an any-of
 * alternative and the groups intersect.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fromGroups = (
  groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
): CapabilitySet => make(groups)

/**
 * Conservatively proves that every capability `inner` allows is also allowed
 * by `outer`: each group of `outer` covers, by `subsumes`, every pattern of
 * some group of `inner`. It returns `false` for any containment its syntactic
 * checks cannot prove, so a `true` never lets `inner` stand for authority
 * `outer` lacks. Even a `*` pattern rejects some resources an unrestricted set
 * allows (an absolute path with a dot segment), so unrestricted `inner` is
 * within only an unrestricted `outer`.
 *
 * Returns `false` if either operand is unverified.
 *
 * @category predicates
 * @since 1.0.0
 */
export const within = (
  inner: CapabilitySet,
  outer: CapabilitySet
): boolean => {
  const innerGroups = readVerifiedGroups(inner)
  const outerGroups = readVerifiedGroups(outer)
  if (innerGroups === undefined || outerGroups === undefined) {
    return false
  }
  return outerGroups.every((group) =>
    innerGroups.some((candidate) => candidate.every((pattern) => group.some((cover) => subsumes(cover, pattern))))
  )
}

// ----------------------------------------------------------------------------
// Unforgeable ambient ceiling & closure-bound service attenuation
// ----------------------------------------------------------------------------

const SealBrand: unique symbol = Symbol("@smthrs/capability/CeilingSeal")
const CurrentCapabilitiesKey: unique symbol = Symbol("@smthrs/capability/CurrentCapabilities")
const AbsentSeal: unique symbol = Symbol("@smthrs/capability/AbsentSeal")

/**
 * Well-known monotone service attenuation hook implemented by guarded services
 * (such as `GrantStore`). Knowing this symbol confers no widening authority:
 * compliant implementations intersect their closure-bound ceiling with the
 * argument and fail closed on unverified inputs.
 */
const AttenuateServiceSymbol: symbol = Symbol.for("@smthrs/capability/attenuateService")

interface CeilingSeal {
  readonly [SealBrand]: typeof SealBrand
}

const sealCeilings = new WeakMap<object, CapabilitySet>()

const mintSeal = (ceiling: CapabilitySet): CeilingSeal => {
  const seal = Object.freeze(Object.create(null)) as CeilingSeal
  sealCeilings.set(seal, ceiling)
  return seal
}

/**
 * Non-reference Context.Service keyed by a module-private Symbol so:
 * 1. No caller can collide with it via `Context.Reference("@smthrs/kernel/CurrentCapabilities", ...)`.
 * 2. `Context.getOrElse` distinguishes an absent key (`AbsentSeal`) from a
 *    tampered slot (including `undefined`, `null`, `{ groups: [] }`, or a
 *    publicly constructed `CapabilitySet` written via `ctx.mapUnsafe`).
 */
const CurrentCapabilities = Context.Service<CeilingSeal>(
  CurrentCapabilitiesKey as unknown as string
)

const readContextCeiling = (context: Context.Context<never>): CapabilitySet => {
  const entry: unknown = Context.getOrElse(
    context,
    CurrentCapabilities,
    () => AbsentSeal as unknown as CeilingSeal
  )
  if (entry === AbsentSeal) {
    return unrestricted
  }
  if (typeof entry !== "object" || entry === null) {
    return none
  }
  return sealCeilings.get(entry) ?? none
}

interface FiberFrame {
  readonly ceiling: CapabilitySet
  readonly excludedChildren: ReadonlySet<object> | undefined
}

interface InternalFiberShape {
  readonly context: Context.Context<never>
  readonly _parent?: InternalFiberShape | undefined
  readonly _children?: ReadonlySet<object> | undefined
}

const fiberFrames = new WeakMap<object, Array<FiberFrame>>()

const pushFiberFrame = (fiber: InternalFiberShape, ceiling: CapabilitySet): FiberFrame => {
  const existingChildren = fiber._children
  const frame: FiberFrame = {
    ceiling,
    excludedChildren: existingChildren !== undefined && existingChildren.size > 0
      ? new Set(existingChildren)
      : undefined
  }
  const stack = fiberFrames.get(fiber)
  if (stack === undefined) {
    fiberFrames.set(fiber, [frame])
  } else {
    stack.push(frame)
  }
  return frame
}

const popFiberFrame = (fiber: object, frame: FiberFrame): void => {
  const stack = fiberFrames.get(fiber)!
  stack.splice(stack.lastIndexOf(frame), 1)
  if (stack.length === 0) {
    fiberFrames.delete(fiber)
  }
}

const readFiberStackCeiling = (fiber: InternalFiberShape): CapabilitySet => {
  let effective = unrestricted
  let cursor: InternalFiberShape | undefined = fiber
  let directChild: object | undefined
  while (cursor !== undefined) {
    const stack = fiberFrames.get(cursor)
    if (stack !== undefined) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const frame = stack[index]!
        if (
          directChild !== undefined &&
          frame.excludedChildren !== undefined &&
          frame.excludedChildren.has(directChild)
        ) {
          continue
        }
        effective = intersect(effective, frame.ceiling)
        break
      }
    }
    directChild = cursor
    cursor = cursor._parent
  }
  return effective
}

const resolveFiberCeiling = (fiber: InternalFiberShape): CapabilitySet =>
  intersect(readContextCeiling(fiber.context), readFiberStackCeiling(fiber))

const getAttenuator = (
  value: unknown
): ((ceiling: CapabilitySet) => unknown) | undefined => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, AttenuateServiceSymbol)
  return descriptor !== undefined &&
      descriptor.writable === false &&
      descriptor.configurable === false &&
      typeof descriptor.value === "function"
    ? (descriptor.value as (ceiling: CapabilitySet) => unknown)
    : undefined
}

const attenuateContext = <R>(
  context: Context.Context<R>,
  seal: CeilingSeal,
  nextCeiling: CapabilitySet
): Context.Context<R> => {
  let updated: Context.Context<R> = context
  for (const [key, value] of context.mapUnsafe) {
    if ((key as unknown) === CurrentCapabilitiesKey) {
      continue
    }
    const attenuator = getAttenuator(value)
    if (attenuator !== undefined) {
      updated = Context.addUnsafe<R, never, unknown>(updated, key, attenuator.call(value, nextCeiling))
    }
  }
  return Context.addUnsafe<R, never, CeilingSeal>(
    updated,
    CurrentCapabilitiesKey as unknown as string,
    seal
  )
}

const attenuateWith = (
  target: CapabilitySet
) =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.withFiber((fiber) => {
      const internal = fiber as unknown as InternalFiberShape
      const nextCeiling = intersect(resolveFiberCeiling(internal), target)
      const seal = mintSeal(nextCeiling)
      const frame = pushFiberFrame(internal, nextCeiling)
      return restore(
        Effect.updateContext(effect, (context: Context.Context<R>) => attenuateContext(context, seal, nextCeiling))
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            popFiberFrame(internal, frame)
          })
        )
      )
    })
  )

/**
 * Reads the current fiber's capability authority.
 *
 * The underlying ceiling seal and active fiber frame stack are module-private
 * and unforgeable. Callers can inspect authority and attenuate it, but cannot
 * widen, strip, or replace it with a forged service or context mutation.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const current: Effect.Effect<CapabilitySet> = Effect.withFiber((fiber) =>
  Effect.succeed(resolveFiberCeiling(fiber as unknown as InternalFiberShape))
)

/**
 * Runs an effect with authority intersected with one additional any-of group.
 *
 * Patterns are snapshotted eagerly when `attenuate` is called so subsequent
 * mutations to the input array or pattern objects cannot alter the ceiling.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const attenuate = (
  patterns: ReadonlyArray<CapabilityPattern>
): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> => attenuateWith(fromPatterns(patterns))

/**
 * Runs with every persisted ceiling, intersecting with current authority.
 *
 * Groups are snapshotted eagerly when `attenuateGroups` is called so subsequent
 * mutations cannot alter the ceiling.
 *
 * @category combinators
 * @since 1.0.0
 */
export const attenuateGroups = (
  groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> => attenuateWith(fromGroups(groups))
