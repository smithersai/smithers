// Deep reviewed and polished by a human on 2026-08-10.

/**
 * RFC 8785 canonical JSON, the serialization every digest in `@smthrs/flows` uses.
 *
 * {@link canonicalize} matches `JSON.stringify` for JSON data, `toJSON(key)`,
 * boxed primitives, sparse arrays, getters, and proxies, while sorting object
 * keys by UTF-16 code units. It rejects digest-unsafe non-plain built-ins.
 * Its stable failures are `canonical_nan`, `canonical_non_finite`,
 * `canonical_lone_surrogate`, `canonical_circular`,
 * `canonical_unsupported_value`, `canonical_bigint`,
 * `canonical_depth_exceeded`, `canonical_tojson_threw`, and
 * `canonical_getter_threw`; every {@link CanonicalError} includes the offending
 * JSON-style path. The supported nesting bound is 10,000 levels below `$`.
 *
 * Output changes are digest changes. Never alter this serialization contract
 * without auditing every consumer that persists a digest.
 *
 * ```ts
 * import { Canonical } from "@smthrs/canonical"
 * import * as Schema from "effect/Schema"
 *
 * const document = Schema.decodeUnknownSync(Canonical)({ b: 1, a: 2 })
 * // => `{"a":2,"b":1}`
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export * from "./Canonical.ts"
export { CanonicalError, canonicalize } from "./Serializer.ts"
export type { CanonicalErrorCode } from "./Serializer.ts"

/**
 * Object-shape guard for values crossing a wire boundary.
 *
 * @since 1.0.0
 * @category guards
 */
export { isRecord } from "./Record.ts"

/**
 * Bounded descriptor-only admission for untrusted durable JSON.
 * @category validation
 * @since 1.0.0
 */
export * as BoundedJson from "./BoundedJson.ts"
