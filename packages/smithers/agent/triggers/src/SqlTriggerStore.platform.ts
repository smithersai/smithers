/**
 * Row decoding and host randomness for the SQL trigger store, kept apart
 * because decoding throws where a store listing needs a plain {@link Result}.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import * as Trigger from "./Trigger.vibe"
import type { Registered } from "./TriggerStore.vibe"

/**
 * One `flows_triggers` row as SQL returns it.
 *
 * @since 1.0.0
 */
export interface Row {
  readonly trigger_id: string
  readonly flow_id: string
  readonly input_json: string
  readonly cron: string
  readonly timezone: string | null
  readonly overlap: string
  readonly catch_up: string
  readonly max_catch_up: number
  readonly enabled: number
  readonly revision: number
  readonly last_fired_at_ms: number | null
  readonly active_run_id: string | null
  readonly pending_at_ms: number | null
}

// A stored row is decoded through the same schema `register` accepts, plus the
// store-owned fields, rather than cast. The table's CHECKs cover the policy
// literals but not the catch-up bound or the non-empty strings, and a row
// anyone rewrote must not reach the scheduler as a declaration `register`
// would have refused.
const StoredDeclaration = Schema.Struct({
  ...Trigger.Trigger.fields,
  revision: Schema.Int,
  lastFiredAt: Schema.optional(Schema.Number)
})
const decodeDeclaration = Schema.decodeUnknownSync(StoredDeclaration)

/**
 * Decodes a trigger row, throwing when the row or its input cannot be read.
 *
 * @since 1.0.0
 */
export const declaration = (row: Row): Registered =>
  decodeDeclaration({
    id: row.trigger_id,
    flowId: row.flow_id,
    input: JSON.parse(row.input_json),
    cron: row.cron,
    ...(row.timezone === null ? {} : { timezone: row.timezone }),
    overlap: row.overlap,
    catchUp: row.catch_up,
    maxCatchUp: row.max_catch_up,
    enabled: row.enabled === 1,
    revision: row.revision,
    ...(row.last_fired_at_ms === null ? {} : { lastFiredAt: row.last_fired_at_ms })
  })


/**
 * A random identifier unique enough to tell two reservations apart.
 *
 * @throws {never}
 * @since 1.0.0
 */
export const randomId = (): string => globalThis.crypto.randomUUID()
