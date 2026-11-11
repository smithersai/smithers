/**
 * Electric's `transformer` over an Electric collection's row schema. TanStack
 * DB expects a row that doesn't decode to throw, which stops the shape, so this
 * plain TypeScript module keeps the throwing call out of `ElectricCollection.vibe`.
 *
 * @since 0.1.0
 */

import type { Row } from "@electric-sql/client"
import * as Schema from "effect/Schema"

/**
 * Decodes each synced row with every field optional: an update carries only
 * the columns that changed. A row schema checks without transforming
 * (`Collection.RowSchema`), so each field decodes with no services.
 *
 * @private
 * @since 0.1.0
 * @throws {never}
 */
export const columnwiseTransformer = (fields: Schema.Struct.Fields): (row: Row) => Row => {
  const decode = Schema.decodeUnknownSync(
    Schema.Struct(
      Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, Schema.optionalKey(field)]))
    ) as unknown as Schema.Codec<unknown>
  )
  return (row) => decode(row) as Row
}
