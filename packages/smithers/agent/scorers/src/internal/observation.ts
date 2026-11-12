/**
 * Shared observation redaction and canonical metadata encoding.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Redaction from "@smthrs/journal/Redaction"
import * as Effect from "effect/Effect"
import { ScorerError } from "../ScorerError.ts"
import * as ScoreStore from "../ScoreStore.ts"
import * as Json from "./json.ts"
import * as Text from "./text.ts"

/**
 * The scrub every returned and stored `reason` and `meta` passes through.
 *
 * Eval reports and CI gate summaries consume Scoring outcomes directly;
 * observation readers consume the durable rows. Both paths must scrub a
 * credential before handing it to a consumer. A scorer earns those strings
 * from places nobody controls: a judge client whose failure message quotes
 * the request it sent, a judge whose prose quotes the agent output it graded. The byte bounds do
 * not help, because a bearer token, an `Authorization` header, or a URL with
 * embedded credentials fits inside the first kilobyte.
 *
 * The journal's own rule set is used rather than a second one, so both durable
 * prose surfaces of this database scrub the same shapes. `onTooDeep` names a
 * member past the redactor's depth bound instead of throwing: refusing the
 * write is how a scorer diagnostic gets lost, which is the opposite of what
 * this store is for.
 *
 * @private
 * @since 0.1.0
 */
const redactor = Redaction.make({ onTooDeep: "name" })

/**
 * Scrubs a reason and re-applies its byte bound.
 *
 * A placeholder is longer than some of the credentials it replaces, so a
 * producer that already truncated to `maxReasonBytes` can hand this prose that
 * the bound would then reject, dropping exactly the diagnostic that carried the
 * credential. Prose truncates on a code-point boundary and stays prose; JSON
 * does not, which is why `meta` is refused instead. Truncation can expose a
 * token boundary the original text did not have, so the bounded text passes
 * through redaction once more before reaching a consumer.
 *
 * `Redactor` is typed over `unknown` because it walks arbitrary payloads; a
 * string always redacts to a string.
 *
 * @private
 * @since 0.1.0
 */
export const redactReason = (reason: string): string => {
  const bounded = Text.truncate(String(redactor(reason)), ScoreStore.maxReasonBytes)
  return Text.truncate(String(redactor(bounded)), ScoreStore.maxReasonBytes)
}

/**
 * Classifies an observation that cannot be persisted without data loss.
 *
 * @private
 * @since 0.1.0
 */
export const invalid = (message: string, cause?: unknown): ScorerError =>
  new ScorerError({
    code: "invalid_observation",
    message,
    ...(cause === undefined ? {} : { cause })
  })

/**
 * Encodes `meta` through the canonical form the scorer key already uses.
 *
 * A bare `JSON.stringify` inside `writer.write` ran caller code (getters,
 * Proxy traps, `toJSON`) while holding the single-writer transaction, and
 * preserved insertion order rather than the canonical key order every other
 * identity in this package is built from. Encoding here, before the
 * transaction opens, also bounds the stored size.
 *
 * @private
 * @since 0.1.0
 */
export const metadataJson = (observation: ScoreStore.Observation): Effect.Effect<string | null, ScorerError> => {
  if (observation.kind === "inconclusive" || observation.meta === undefined) return Effect.succeed(null)
  const meta = observation.meta
  let canonical: string
  try {
    const lossy = Json.lossyPath(meta, "meta")
    if (lossy !== undefined) {
      return Effect.fail(
        invalid(`Score observation metadata is not representable as canonical JSON: ${lossy}`)
      )
    }
    canonical = Digest.canonical(meta)
  } catch (cause) {
    return Effect.fail(invalid("Score observation metadata is not representable as canonical JSON", cause))
  }
  // Redacting the encoded text rather than the caller's object keeps the walk
  // over plain JSON: no getter, Proxy trap, or `toJSON` of the caller's runs a
  // second time, and the canonical key order survives. The bound is measured on
  // what is stored, so a payload the scrub grows past it is refused.
  const encoded = Redaction.redactJsonString(canonical, redactor)
  return Text.byteLength(encoded) > ScoreStore.maxMetadataBytes
    ? Effect.fail(
      invalid(
        `Score observation metadata exceeds ${ScoreStore.maxMetadataBytes} UTF-8 bytes`
      )
    )
    : Effect.succeed(encoded)
}
