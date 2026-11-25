/**
 * Provenance the engine stamps on every output: the run, node and attempt
 * that wrote it, its place in the journal, the plan revision that caused it,
 * and the hash of the intent. A receipt is written once, when the output
 * commits, and never changes.
 *
 * `ref/cause` reads one back by output reference: the exact receipt, or a
 * typed `provenance_missing` or `unauthorized` that says nothing else.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A JSON value.
 *
 * @category models
 * @since 1.0.0
 */
export type Json = Schema.Json

/**
 * A reference to an output.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Ref = Schema.NonEmptyString

/**
 * The pinned plan block an output came from: its page, block and revision.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PlanRef = Schema.Struct({ page: Schema.String, blockId: Schema.String, rev: Schema.String })

/**
 * The pinned plan block an output came from.
 *
 * @category models
 * @since 1.0.0
 */
export type PlanRef = typeof PlanRef.Type

/**
 * Where an output came from when no plan block caused it: a `direct` intent,
 * or the `system`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Origin = Schema.Struct({ origin: Schema.Literals(["direct", "system"]) })

/**
 * Where an output came from when no plan block caused it.
 *
 * @category models
 * @since 1.0.0
 */
export type Origin = typeof Origin.Type

/**
 * The provenance of one output.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CauseReceipt = Schema.Struct({
  outputRef: Ref,
  runId: Schema.String,
  nodeId: Schema.String,
  attempt: Schema.Int,
  journalSeq: Schema.Int,
  planRef: Schema.Union([PlanRef, Origin]),
  promptHash: Schema.String
})

/**
 * The provenance of one output.
 *
 * @category models
 * @since 1.0.0
 */
export type CauseReceipt = typeof CauseReceipt.Type

/**
 * The name of the built-in query that reads a receipt: `{ ref }` in, one
 * receipt out.
 *
 * @category constants
 * @since 1.0.0
 */
export const query = "ref/cause"

/**
 * Canonical JSON text: object keys sorted, no whitespace. Equal values give
 * equal bytes.
 *
 * @category encoding
 * @since 1.0.0
 */
export const canonical = (value: Json): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as { readonly [key: string]: Json }
  return `{${
    Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key] as Json)}`).join(",")
  }}`
}

/**
 * SHA-256 of a text's UTF-8 bytes, in hex. Web Crypto, so it runs in a
 * browser, a Worker, Node and Bun alike.
 *
 * @category encoding
 * @since 1.0.0
 */
export const sha256 = (text: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  })

/**
 * The hash of an intent: its operation and exact payload.
 *
 * @category encoding
 * @since 1.0.0
 */
export const promptHash = (operation: string, payload: Json): Effect.Effect<string> =>
  sha256(canonical({ operation, payload }))

/**
 * Freezes a receipt and its plan reference.
 *
 * @category constructors
 * @since 1.0.0
 */
export const stamp = (receipt: CauseReceipt): CauseReceipt =>
  Object.freeze({ ...receipt, planRef: Object.freeze({ ...receipt.planRef }) })

/**
 * What a ledger answers for a reference.
 *
 * @category models
 * @since 1.0.0
 */
export type Lookup =
  | { readonly _tag: "Found"; readonly receipt: CauseReceipt }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Private" }

/**
 * Every receipt the engine stamped, by output reference.
 *
 * @category models
 * @since 1.0.0
 */
export interface Ledger {
  /** Records a receipt. `owner` set means only that subject may read it. */
  readonly record: (receipt: CauseReceipt, owner?: string) => void
  /** Reads a receipt as `subject`. A private receipt answers `Private` and nothing more. */
  readonly lookup: (ref: string, subject: string) => Lookup
  /** Every receipt, in journal order. */
  readonly receipts: () => ReadonlyArray<CauseReceipt>
}

/**
 * An empty ledger.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ledger = (): Ledger => {
  const entries = new Map<string, { readonly receipt: CauseReceipt; readonly owner: string | undefined }>()
  return {
    record: (receipt, owner) => {
      // First write wins: a receipt is immutable once stamped.
      if (!entries.has(receipt.outputRef)) entries.set(receipt.outputRef, { receipt: stamp(receipt), owner })
    },
    lookup: (ref, subject) => {
      const entry = entries.get(ref)
      if (entry === undefined) return { _tag: "Missing" }
      if (entry.owner !== undefined && entry.owner !== subject) return { _tag: "Private" }
      return { _tag: "Found", receipt: entry.receipt }
    },
    receipts: () => Array.from(entries.values(), (entry) => entry.receipt)
  }
}
