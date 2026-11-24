/**
 * Value predicates a host can answer without running the value's own code.
 *
 * Projecting a settlement the flow's codec rejected must not execute user
 * code. A `Proxy` runs its handler on every reflective read, and the point of
 * `./ExitEncoding.ts` is to describe the value a round is already failing on,
 * not to hand that value another turn on the terminal-transition path. Node
 * answers the question from an internal slot, through `node:util/types`. No
 * ECMAScript operation does: virtualization is transparent by design, so a
 * proxy and its target are indistinguishable to portable code.
 *
 * Binding `node:util/types` with a static import states that answer as a
 * build-time dependency, and that is wrong twice. `@smthrs/engine-store` is a
 * browser entry point in the release policy and in
 * `packages/repo-targets/browser/browser-contract.mjs`, so the import fails `pnpm run browser`; and
 * it claims a capability every host has, which is false. This module reads the
 * predicates off the host instead, the way `../OwnerIdentity.ts` reads a
 * process id: `process.getBuiltinModule` when the host offers it, portable
 * fallbacks when it does not. Node and Bun both take the first path, so on the
 * runtimes the durable engine supports the behavior is exactly what the static
 * import gave. A browser takes the second, where proxy detection does not
 * exist. There the fallback is inert: every object is treated as opaque, so a
 * projection never reads a descriptor, a prototype or `Symbol.toStringTag` of
 * a value it cannot prove is not a proxy. A host that can answer supplies its
 * own {@link Reflection} through {@link Current}.
 *
 * The lookup grants no authority, which is why it is resolved here rather than
 * routed through a `HostServices` port. The whole surface of
 * `node:util/types` is predicates over values already in hand: no filesystem,
 * no process, no clock, no randomness. A port exists to keep nondeterminism
 * and I/O out of a composition, and a pure type test is neither.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
/**
 * The part of a host this module reads.
 *
 * `process.getBuiltinModule` is the synchronous built-in accessor Node has
 * exposed since 22.3 and Bun since 1.2. It is typed structurally rather than
 * imported from `@types/node` so the module carries no Node binding at all.
 *
 * @since 1.0.0
 * @category models
 */
export interface BuiltinSource {
  readonly getBuiltinModule?: ((id: string) => unknown) | undefined
}

/**
 * The reflective operations a projection needs.
 *
 * @since 1.0.0
 * @category models
 */
export interface Reflection {
  /** Whether reading this object would run a proxy handler. */
  readonly isProxy: (value: object) => boolean
  /** Whether this value carries the error internal slot, in any realm. */
  readonly isNativeError: (value: unknown) => boolean
  /** Reads an own property without invoking its accessor. */
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor
  /** Reads an object's prototype. */
  readonly getPrototypeOf: typeof Object.getPrototypeOf
  /** Serializes a plain diagnostic projection. */
  readonly stringify: typeof JSON.stringify
}

/**
 * The intrinsics the portable fallback may consult.
 *
 * `Error.isError` (ES2026) answers from the error internal slot alone: it
 * reads no property and returns `false` for a proxy without running a trap.
 *
 * @since 1.0.0
 * @category models
 */
export interface PortableIntrinsics {
  readonly Error?: { readonly isError?: ((value: unknown) => boolean) | undefined } | undefined
}

/**
 * The stance of a host that cannot detect a proxy.
 *
 * Answering yes makes every object opaque to the projections: they return
 * their `[unrepresentable]` or `null` form without reading a descriptor, so no
 * trap and no accessor can run on the failure path. Portable code cannot tell
 * a proxy from its target, and answering no would hand a caller's handler a
 * turn while a terminal write is in flight. Primitives keep their text.
 */
const opaqueObject = (): boolean => true

/**
 * The portable native-error test.
 *
 * Only the slot-based `Error.isError` is consulted. `Object.prototype.toString`
 * reads `Symbol.toStringTag`, which a caller can define as a getter, so a host
 * without the intrinsic answers no instead.
 */
const slotNativeError = (intrinsics: PortableIntrinsics): (value: unknown) => boolean => {
  let isError: unknown
  try {
    isError = intrinsics.Error?.isError
  } catch {
    isError = undefined
  }
  if (typeof isError !== "function") return () => false
  const test = isError as (value: unknown) => boolean
  return (value) => {
    try {
      return test(value) === true
    } catch {
      return false
    }
  }
}

/**
 * The predicate module a host offers, when it offers one.
 *
 * A host that implements the accessor but rejects the id must degrade rather
 * than raise: this module is imported by the path that exists so a terminal
 * write can never fail.
 */
const builtinTypes = (source: BuiltinSource | undefined): Partial<Reflection> | undefined => {
  try {
    const types = source?.getBuiltinModule?.("node:util/types")
    return typeof types === "object" && types !== null ? types : undefined
  } catch {
    return undefined
  }
}

/**
 * Builds the reflection one host can supply.
 *
 * Each predicate is taken only when the host names it as a function, so a host
 * that grows a partial `node:util/types` shim keeps the inert portable answer
 * for whatever it left out. Both are read as plain functions of their argument,
 * which is what Node and Bun export.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = (
  source: BuiltinSource | undefined,
  intrinsics: PortableIntrinsics = globalThis as PortableIntrinsics
): Reflection => {
  const types = builtinTypes(source)
  return {
    isProxy: typeof types?.isProxy === "function" ? types.isProxy : opaqueObject,
    isNativeError: typeof types?.isNativeError === "function" ? types.isNativeError : slotNativeError(intrinsics),
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    getPrototypeOf: Object.getPrototypeOf,
    stringify: JSON.stringify
  }
}

/**
 * The reflection this process runs with.
 *
 * Read off `globalThis` rather than through a bare `process` reference, so a
 * browser bundle sees `undefined` here and falls through to the inert
 * portable predicates.
 *
 * @since 1.0.0
 * @category constants
 */
export const host: Reflection = make((globalThis as { readonly process?: BuiltinSource }).process)

/**
 * Reflection used while persisting an action failure.
 *
 * Hosts retain their native predicates by default. A host layer provides its
 * own reflection here, either native predicates the default lookup cannot
 * reach or one that refuses inspection, without changing process-wide
 * intrinsics.
 *
 * @since 1.0.0
 * @category services
 */
export const Current = Context.Reference<Reflection>("@smthrs/engine-store/internal/HostReflection", {
  defaultValue: () => host
})
