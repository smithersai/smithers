/**
 * Internal-slot brand detection for built-in values.
 *
 * `instanceof` and `Symbol.toStringTag` follow a mutable prototype chain and
 * miss values from another realm. The intrinsic operations below read the
 * internal slots instead, so a populated `ArrayBuffer` with a null prototype
 * is still a buffer and a cross-realm `Number` wrapper still unboxes.
 *
 * @since 1.0.0
 */

import { rethrowUnlessMissingSlot } from "./slotFailure.ts"

/**
 * The built-in a value carries internal slots for.
 *
 * `"ArrayBufferView"` covers typed arrays and `DataView`. The wrapper brands
 * (`Number`, `String`, `Boolean`, `BigInt`, `Symbol`) identify boxed
 * primitives whose value `X.prototype.valueOf.call(value)` reads safely.
 *
 * @category models
 * @since 1.0.0
 */
export type NativeBrand =
  | "ArrayBuffer"
  | "ArrayBufferView"
  | "BigInt"
  | "Boolean"
  | "Date"
  | "Error"
  | "Map"
  | "Number"
  | "RegExp"
  | "Set"
  | "SharedArrayBuffer"
  | "String"
  | "Symbol"
  | "WeakMap"
  | "WeakSet"

const getter = (prototype: object, key: string): ((this: unknown) => unknown) | undefined =>
  Object.getOwnPropertyDescriptor(prototype, key)?.get

/**
 * How many slot probes have thrown since this module loaded.
 *
 * A thrown `TypeError` is the only portable way to learn that a slot is
 * absent, and each one costs about a microsecond. Tests read this counter to
 * prove a path stays off the throwing probes.
 *
 * @since 1.0.0
 * @private
 */
export const missedProbes = { count: 0 }

/**
 * The globals a brand reader consults for a built-in some hosts lack.
 *
 * @since 1.0.0
 * @private
 */
export interface OptionalIntrinsics {
  readonly Error?: { readonly isError?: ((value: unknown) => boolean) | undefined } | undefined
  readonly SharedArrayBuffer?: { readonly prototype: object } | undefined
  readonly URL?: { readonly prototype: object } | undefined
}

type Probe = readonly [NativeBrand, (value: object) => unknown]

// Each probe throws a TypeError when its receiver lacks the slot. None runs
// caller code: an intrinsic on a Proxy throws without consulting its traps.
const slotProbes = (sharedBuffer: OptionalIntrinsics["SharedArrayBuffer"]): ReadonlyArray<Probe> => [
  ["Map", (value) => Reflect.apply(Map.prototype.has, value, [value])],
  ["Set", (value) => Reflect.apply(Set.prototype.has, value, [value])],
  ["WeakMap", (value) => Reflect.apply(WeakMap.prototype.has, value, [value])],
  ["WeakSet", (value) => Reflect.apply(WeakSet.prototype.has, value, [value])],
  ["ArrayBuffer", (value) => Reflect.apply(getter(ArrayBuffer.prototype, "byteLength")!, value, [])],
  ...(sharedBuffer === undefined ? [] : [
    [
      "SharedArrayBuffer",
      (value: object) => Reflect.apply(getter(sharedBuffer.prototype, "byteLength")!, value, [])
    ] as const
  ]),
  ["Date", (value) => Reflect.apply(Date.prototype.getTime, value, [])],
  // %RegExp.prototype% answers the `source` getter without having the slot.
  ["RegExp", (value) => {
    if (value === RegExp.prototype) throw new TypeError("RegExp.prototype has no matcher")
    return Reflect.apply(getter(RegExp.prototype, "source")!, value, [])
  }],
  ["Number", (value) => Reflect.apply(Number.prototype.valueOf, value, [])],
  ["String", (value) => Reflect.apply(String.prototype.valueOf, value, [])],
  ["Boolean", (value) => Reflect.apply(Boolean.prototype.valueOf, value, [])],
  ["BigInt", (value) => Reflect.apply(BigInt.prototype.valueOf, value, [])],
  ["Symbol", (value) => Reflect.apply(Symbol.prototype.valueOf, value, [])]
]

// The non-throwing slot predicates of `node:util/types`, in probe order.
const predicateNames = [
  ["Map", "isMap"],
  ["Set", "isSet"],
  ["WeakMap", "isWeakMap"],
  ["WeakSet", "isWeakSet"],
  ["ArrayBuffer", "isArrayBuffer"],
  ["SharedArrayBuffer", "isSharedArrayBuffer"],
  ["Date", "isDate"],
  ["RegExp", "isRegExp"],
  ["Number", "isNumberObject"],
  ["String", "isStringObject"],
  ["Boolean", "isBooleanObject"],
  ["BigInt", "isBigIntObject"],
  ["Symbol", "isSymbolObject"]
] as const satisfies ReadonlyArray<readonly [NativeBrand, string]>

type Predicate = (value: unknown) => boolean

/**
 * Where a host publishes its built-in modules, as `process` does on Node, Bun
 * and Cloudflare Workers.
 *
 * @since 1.0.0
 * @private
 */
export interface BuiltinSource {
  readonly getBuiltinModule?: ((id: string) => unknown) | undefined
}

/**
 * The host's slot predicates, or `undefined` unless it supplies every one.
 *
 * A partial shim is refused whole: mixing its answers with the probes would
 * make a value's brand depend on which half answered.
 */
const hostPredicates = (
  source: BuiltinSource | undefined
): ReadonlyArray<readonly [NativeBrand, Predicate]> | undefined => {
  let types: unknown
  try {
    types = source?.getBuiltinModule?.("node:util/types")
  } catch {
    return undefined
  }
  if (typeof types !== "object" || types === null) return undefined
  const found: Array<readonly [NativeBrand, Predicate]> = []
  for (const [brand, name] of predicateNames) {
    const predicate: unknown = (types as Record<string, unknown>)[name]
    if (typeof predicate !== "function") return undefined
    found.push([brand, predicate as Predicate])
  }
  return found
}

/**
 * The brand readers of one host.
 *
 * @since 1.0.0
 * @private
 */
export interface NativeBrands {
  readonly nativeBrand: (value: object) => NativeBrand | undefined
  readonly isNativeUrl: (value: object) => boolean
  readonly slotlessProxy: <T extends object>(target: T, handler: ProxyHandler<T>) => T
}

/**
 * Builds the brand readers for a host.
 *
 * A host that publishes `node:util/types` answers from its non-throwing slot
 * predicates. Any other host, a browser included, falls back to the portable
 * probes, which throw once for every slot a value lacks.
 *
 * @param source - The host's built-in module accessor, when it has one.
 * @param intrinsics - The host's globals. A host without `URL` or
 * `SharedArrayBuffer` has no such brand, and one without `Error.isError`
 * reads an error from its prototype chain.
 * @since 1.0.0
 * @private
 */
export const makeNativeBrands = (
  source: BuiltinSource | undefined,
  intrinsics: OptionalIntrinsics = globalThis as OptionalIntrinsics
): NativeBrands => {
  const predicates = hostPredicates(source)
  const probes = slotProbes(intrinsics.SharedArrayBuffer)
  const isError = intrinsics.Error?.isError
  const url = intrinsics.URL
  const urlHref = url === undefined ? undefined : getter(url.prototype, "href")
  // Internal slots cannot be added to an existing object. Remember negative
  // probes weakly so repeated digests do not pay for them again.
  const unbranded = new WeakSet<object>()
  const notUrl = new WeakSet<object>()

  const probed = (value: object): NativeBrand | undefined => {
    for (const [brand, probe] of probes) {
      try {
        probe(value)
        return brand
      } catch (cause) {
        rethrowUnlessMissingSlot(cause)
        missedProbes.count += 1
      }
    }
    unbranded.add(value)
    return undefined
  }

  const predicated = (
    found: ReadonlyArray<readonly [NativeBrand, Predicate]>,
    value: object
  ): NativeBrand | undefined => {
    for (const [brand, predicate] of found) {
      if (predicate(value)) return brand
    }
    return undefined
  }

  return {
    nativeBrand: (value) => {
      if (unbranded.has(value)) return undefined
      if (ArrayBuffer.isView(value)) return "ArrayBufferView"
      if (isError === undefined ? value instanceof Error : isError(value)) return "Error"
      return predicates === undefined ? probed(value) : predicated(predicates, value)
    },
    isNativeUrl: (value) => {
      if (urlHref === undefined || notUrl.has(value)) return false
      try {
        Reflect.apply(urlHref, value, [])
        return true
      } catch (cause) {
        rethrowUnlessMissingSlot(cause)
        missedProbes.count += 1
        notUrl.add(value)
        return false
      }
    },
    slotlessProxy: (target, handler) => {
      const proxy = new Proxy(target, handler)
      unbranded.add(proxy)
      notUrl.add(proxy)
      return proxy
    }
  }
}

const host = makeNativeBrands((globalThis as { readonly process?: BuiltinSource }).process)

/**
 * Reads which built-in `value` is from its internal slots.
 *
 * The answer ignores the prototype chain and `Symbol.toStringTag`, works
 * across realms, and runs no caller code. A Proxy has no slots of its own and
 * reports `undefined`. Failures other than a missing-slot `TypeError`, such
 * as stack exhaustion, propagate and are not cached.
 *
 * On a host that publishes `node:util/types` (Node, Bun, Cloudflare Workers)
 * an ordinary object costs no thrown error. Elsewhere each slot an object
 * lacks costs one caught `TypeError`, paid once per object.
 *
 * @param value - Any object or function.
 * @returns The built-in brand, or `undefined` for an ordinary object.
 * @category guards
 * @since 1.0.0
 */
export const nativeBrand: (value: object) => NativeBrand | undefined = host.nativeBrand

/**
 * Whether `value` carries the internal state of a `URL`.
 *
 * `URL` has no non-throwing slot predicate on any host, so this is kept out
 * of {@link nativeBrand}: an object that is not a `URL` costs one caught
 * `TypeError`, paid once per object. The answer ignores the prototype chain,
 * so a `URL` whose prototype was replaced with `null` is still a `URL`. A
 * Proxy reports `false`, and so does every value on a host without `URL`.
 *
 * @param value - Any object or function.
 * @returns `true` only for a real `URL` instance.
 * @category guards
 * @since 1.0.0
 */
export const isNativeUrl: (value: object) => boolean = host.isNativeUrl

/**
 * Creates a Proxy and records that it has no internal slots.
 *
 * A Proxy never has slots of its own, whatever its target, so
 * {@link nativeBrand} and {@link isNativeUrl} answer for it without probing.
 * Use it for a view that is canonicalized once per source object, where the
 * portable probes would otherwise run for the source and again for its view.
 *
 * @param target - The Proxy target.
 * @param handler - The Proxy handler.
 * @returns `new Proxy(target, handler)`.
 * @category constructors
 * @since 1.0.0
 */
export const slotlessProxy: <T extends object>(target: T, handler: ProxyHandler<T>) => T = host.slotlessProxy
