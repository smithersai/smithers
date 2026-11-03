/**
 * The writer lock a transaction or savepoint asks its driver for.
 *
 * @since 1.0.0
 */

import { Context } from "effect"

/**
 * The partition the transaction or savepoint about to begin writes, or
 * `undefined` for the whole store. `DurableWriter.write` sets it around the
 * transaction it opens and clears it for the body, so a write nested inside
 * asks for its own scope rather than inheriting its parent's. A driver whose
 * writes serialize some other way ignores it.
 *
 * @category internal
 * @since 1.0.0
 */
export const Requested = Context.Reference<string | undefined>("@smthrs/database/WriteLock", {
  defaultValue: () => undefined
})

/**
 * Whether the savepoint about to begin may be skipped because the nested write
 * writes nothing: a failure has nothing to undo. `DurableWriter.write` sets it
 * from `WriteOptions.readOnly` around the savepoint and clears it for the body.
 * A driver whose savepoints cost no round trip ignores it.
 *
 * @category internal
 * @since 1.0.0
 */
export const ReadOnlyBody = Context.Reference<boolean>("@smthrs/database/WriteLock/ReadOnlyBody", {
  defaultValue: () => false
})
