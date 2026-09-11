/**
 * How a journal failure's stable code maps onto the sync boundary's error
 * vocabulary.
 *
 * @since 1.0.0-rc.0
 */

/**
 * The journal codes this boundary can state in its own vocabulary.
 *
 * Only codes whose meaning is identical on both sides are here. A journal that
 * is shut down and a sync boundary that is closed are the same fact; an
 * admission queue that overflowed and backpressure are the same fact; a
 * payload the journal could not decode and one this boundary could not decode
 * are the same fact. Everything else — a fence lost, a sequence conflict, a
 * projection fault — is a storage-layer distinction a follower cannot act on,
 * and inventing a sync code for it would say more than is known.
 */
const journalCodes: Readonly<Record<string, "backpressure" | "closed" | "decode_failed">> = {
  decode_failed: "decode_failed",
  journal_closed: "closed",
  queue_overflow: "backpressure"
}

/**
 * Projects one journal failure's stable code onto this boundary's vocabulary,
 * or `unknown` when it has no counterpart.
 *
 * `SyncError.ErrorCode` already declares `closed`, `backpressure`, and
 * `decode_failed`, so collapsing every journal failure but `compacted` into
 * `unknown` threw away a classification the wire could already carry, and left
 * a follower unable to tell a shut-down journal from an unexplained fault.
 * Nothing here widens what a follower learns: `causeCode` already publishes
 * the journal's own enumerated code, and the journal's MESSAGE stays refused
 * on every path.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export const journalErrorCode = (
  cause: unknown
): "backpressure" | "closed" | "decode_failed" | "unknown" => {
  if (!(cause instanceof Error)) return "unknown"
  const code = (cause as { readonly code?: unknown }).code
  return typeof code === "string" ? journalCodes[code] ?? "unknown" : "unknown"
}
