/**
 * The one rule every durable site that hashes or compares a flow payload uses
 * (VIP-44, durable values).
 *
 * `Schema.ReadonlySet` and `Schema.ReadonlyMap` encode in insertion order and
 * RFC 8785 keeps array order, so a site that encodes or hashes a payload
 * without sorting first gives equal sets two identities. Every such site calls
 * this module instead of `Schema.toCodecJson` or `DerivedKey` directly, so none
 * can skip the sort.
 *
 * @since 1.0.0
 */

import { sortCollections } from "@smthrs/canonical"
import { Planned } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const hasRedacted = (value: unknown, seen: Set<object>): boolean => {
  // A planned value is a reference to a later result, never a secret. Probing
  // it with `Redacted.isRedacted` runs an `in` check its proxy refuses.
  if (Planned.isPlanned(value)) return false
  if (Redacted.isRedacted(value)) return true
  if (typeof value !== "object" || value === null || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => hasRedacted(item, seen))
  return Object.values(value).some((entry) => hasRedacted(entry, seen))
}

/**
 * The payload's identity snapshot: `sortCollections`, then the schema's JSON
 * codec. Hashing it under RFC 8785 gives the payload's identity, and decoding
 * it gives the value a durable body must see, so the hash covers exactly what
 * the body runs on.
 *
 * A payload that holds no `Set` or `Map` encodes to the bytes
 * `Schema.toCodecJson` alone gives, so stored payloads and the ids derived
 * from them are unchanged.
 *
 * @category identity
 * @since 1.0.0
 */
export const payloadSnapshot = <S extends Schema.Top>(
  schema: S,
  value: unknown
): Effect.Effect<Schema.Json, Schema.SchemaError, S["EncodingServices"]> =>
  Effect.suspend(() => encodeSorted(schema, sortCollections(value)))

const encodeSorted = <S extends Schema.Top>(
  schema: S,
  sorted: unknown
): Effect.Effect<Schema.Json, Schema.SchemaError, S["EncodingServices"]> =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(sorted)

/**
 * The material a site that has always hashed a payload as written hashes now.
 *
 * Such sites, a child execution id and the recorded plan's root input, could
 * never hash a `Set` or `Map`: RFC 8785 refuses both. So a payload that holds
 * none keeps the exact preimage it always had, and one that holds any is
 * hashed as `["snapshot", payloadSnapshot]`. Released ids are unchanged, and
 * equal collections hash equally.
 *
 * The tag keeps the two forms apart: a flow payload is a struct, so a payload
 * as written is always an object and never this array. Without it a set and
 * an array whose written form equals the set's snapshot would share an id.
 *
 * @category identity
 * @since 1.0.0
 */
export const payloadPreimage = <S extends Schema.Top>(
  schema: S,
  value: unknown
): Effect.Effect<unknown, Schema.SchemaError, S["EncodingServices"]> =>
  Effect.suspend(() => {
    const sorted = sortCollections(value)
    return sorted === value && !hasRedacted(value, new Set())
      ? Effect.succeed(value)
      : Effect.map(encodeSorted(schema, sorted), (snapshot) => ["snapshot", snapshot])
  })
