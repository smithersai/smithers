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

const sharedBuffer = (globalThis as { readonly SharedArrayBuffer?: { readonly prototype: object } }).SharedArrayBuffer
const isError = (Error as unknown as { readonly isError?: (value: unknown) => boolean }).isError

// Each probe throws a TypeError when its receiver lacks the slot. None runs
// caller code: an intrinsic on a Proxy throws without consulting its traps.
const probes: ReadonlyArray<readonly [NativeBrand, (value: object) => unknown]> = [
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

// Internal slots cannot be added to an existing object. Remember negative
// probes weakly so repeated digests do not pay for them again.
const unbranded = new WeakSet<object>()

/**
 * Reads which built-in `value` is from its internal slots.
 *
 * The answer ignores the prototype chain and `Symbol.toStringTag`, works
 * across realms, and runs no caller code. A Proxy has no slots of its own and
 * reports `undefined`. Failures other than a missing-slot `TypeError`, such
 * as stack exhaustion, propagate and are not cached.
 *
 * @param value - Any object or function.
 * @returns The built-in brand, or `undefined` for an ordinary object.
 * @category guards
 * @since 1.0.0
 */
export const nativeBrand = (value: object): NativeBrand | undefined => {
  if (unbranded.has(value)) return undefined
  if (ArrayBuffer.isView(value)) return "ArrayBufferView"
  if (isError === undefined ? value instanceof Error : isError(value)) return "Error"
  for (const [brand, probe] of probes) {
    try {
      probe(value)
      return brand
    } catch (cause) {
      rethrowUnlessMissingSlot(cause)
    }
  }
  unbranded.add(value)
  return undefined
}
