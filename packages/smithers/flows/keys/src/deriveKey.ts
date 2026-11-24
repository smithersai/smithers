// Deep reviewed and polished by a human on 2026-08-31.

/**
 * Derivation of the current flow-key format from structured input.
 *
 * @since 0.1.0
 */

import { Canonical, type NativeBrand, nativeBrand } from "@smthrs/canonical"
import { digest as sha256 } from "@smthrs/crypto"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { KeyDerivationError, type KeyDerivationErrorCode } from "./KeyDerivationError.ts"
import type { KeyV1 } from "./KeyV1.ts"

const derivationFailure = (
  code: KeyDerivationErrorCode,
  message: string,
  cause: unknown
): KeyDerivationError => KeyDerivationError.new({ code, message, cause })

type Position = "root" | "member" | "element"

// Unboxes a wrapper from its internal slot. `instanceof` would miss a
// cross-realm wrapper and accept a slotless `Object.create(Number.prototype)`.
const unbox = (value: object, brand: NativeBrand | undefined): unknown => {
  if (brand === "Number") return Number.prototype.valueOf.call(value)
  if (brand === "String") return String.prototype.valueOf.call(value)
  if (brand === "Boolean") return Boolean.prototype.valueOf.call(value)
  return value
}

// Validate the values Canonical actually reads, including getters and toJSON
// results. A separate prewalk would run user code twice and could validate a
// different value from the one that is hashed.
const checkedMaterial = (input: unknown, refuse: (reason: string) => never): unknown => {
  type View = { readonly value: object; position: Position; serializer: unknown }
  const views = new WeakMap<object, View>()
  const check = (value: unknown, position: Position): unknown => {
    if (Redacted.isRedacted(value)) refuse("redacted value cannot be keyed")
    if (typeof value === "number" && !Number.isFinite(value)) {
      refuse(`${value} cannot be keyed`)
    }
    if (position !== "member" && (value === undefined || typeof value === "symbol")) {
      refuse(`${typeof value} cannot be keyed`)
    }
    if (typeof value === "function" && position === "element") refuse("function cannot be keyed")
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return value
    const array = Array.isArray(value)
    // The view below has no internal slots, so decide the brand on the
    // original before Canonical can only see a plain record.
    const brand = array ? undefined : nativeBrand(value)
    const prototype = Reflect.getPrototypeOf(value)
    const plainPrototype = prototype === Object.prototype || prototype === null
    const native = typeof value === "function" || (!array && (brand !== undefined || !plainPrototype))
    if (brand === "Date" && Number.isNaN(Date.prototype.getTime.call(value))) refuse("invalid date")
    const serializer: unknown = native ? Reflect.get(value, "toJSON") : undefined
    if (native && typeof serializer !== "function") {
      if (typeof value === "function") {
        if (position === "root") refuse("function cannot be keyed")
        return undefined
      }
      // Canonical unboxes these before visiting members. The view has no
      // native slots, so forward the primitive after the one toJSON lookup.
      const primitive = unbox(value, brand)
      if (primitive !== value) return check(primitive, position)
      // Canonical names a built-in through the view's prototype. One whose
      // prototype was replaced would otherwise read as a plain record.
      if (brand !== undefined && plainPrototype) refuse("unsupported collection cannot be keyed")
    }

    const existing = views.get(value)
    if (existing !== undefined) {
      existing.position = position
      existing.serializer = serializer
      return existing.value
    }
    const view: View = {
      position,
      serializer,
      value: new Proxy(array ? [] : {}, {
        get: (_target, key) => {
          const member: unknown = native && key === "toJSON" ? view.serializer : Reflect.get(value, key)
          if (key === "toJSON" && typeof member === "function") {
            return (key: string) => check(Reflect.apply(member, value, [key]), view.position)
          }
          if (typeof key === "symbol" || (array && (key === "length" || key === "toJSON"))) return member
          return check(member, array ? "element" : "member")
        },
        getPrototypeOf: () => prototype,
        ...(array ? {} : {
          ownKeys: () => Object.keys(value),
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
        })
      })
    }
    views.set(value, view)
    return view.value
  }
  return check(input, "root")
}

/**
 * Derives the current flow-key format from structured input.
 *
 * The input is serialized with {@link Canonical}, hashed as UTF-8 SHA-256
 * through the injected Effect `Crypto` service, and prefixed with `key1_`.
 * Callers should include a stable domain and version in structured key
 * material when identities from different protocols must not overlap.
 *
 * Execution reads the input lazily; rerunning the effect canonicalizes it
 * again. Keep mutable input stable when the same identity is required.
 * Failures use `canonicalization_failed` for unsupported input and
 * `digest_failed` for a failed hash. Interruption is preserved.
 *
 * @param input - Canonical key material. Redacted values, invalid dates,
 * non-finite numbers, and array elements that JSON would coerce to null are refused.
 * @returns An effect requiring Crypto that produces a validated version-one key
 * or fails with KeyDerivationError. A missing Crypto service is a defect.
 * @category derivation
 * @since 1.0.0
 */
export const deriveKey = (
  input: unknown
): Effect.Effect<KeyV1, KeyDerivationError, EffectDigest.Digest> =>
  Effect.gen(function*() {
    let reason = "Key input could not be canonicalized"
    const material = yield* Effect.try({
      try: () =>
        checkedMaterial(input, (message) => {
          reason = message
          throw new TypeError(message)
        }),
      catch: (cause) => derivationFailure("canonicalization_failed", reason, cause)
    })
    const serialized = yield* Schema.decodeUnknownEffect(Canonical)(material, {
      reportInput: false
    }).pipe(
      Effect.mapError((cause) =>
        derivationFailure(
          "canonicalization_failed",
          reason,
          cause
        )
      )
    )
    const hash = yield* sha256(serialized).pipe(
      Effect.mapError((cause) =>
        derivationFailure(
          "digest_failed",
          "Canonical key material could not be hashed",
          cause
        )
      )
    )

    return `key1_${hash}` as KeyV1
  })
