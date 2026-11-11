/**
 * What a failed call recorded it produced before it failed.
 *
 * A failure's `value` is a record of the failure, never a result: `null`, or
 * `{ limitMillis }` for a timeout. A flow stopped at its limit may also have
 * produced output first, a command's printed lines, and that is the one part
 * of a failure the cell reads, as `error.output`. Everything that renders a
 * failure reads it from here, so it means the same thing everywhere.
 *
 * @since 1.0.0-rc.17
 * @private
 */

import { isRecord } from "@smthrs/canonical/Record"
import type { Schema } from "effect"

/**
 * The `output` a failure's value recorded, or nothing.
 *
 * @since 1.0.0-rc.17
 * @private
 */
export const failureOutput = (value: Schema.Json): Schema.Json | undefined =>
  isRecord<Schema.Json>(value) && Object.hasOwn(value, "output") ? value["output"] : undefined
