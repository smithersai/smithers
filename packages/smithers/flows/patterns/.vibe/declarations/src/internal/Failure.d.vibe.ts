/**
 * The error schema a composed pattern declares.
 *
 * A durable engine encodes a flow's typed failure through the flow's error
 * schema before it journals it, and `Schema.Unknown` encodes only JSON data.
 * A pattern fails with its own tagged errors or with whatever a member it
 * called failed with, so its schema is a union of its own error schemas, the
 * error schema every member flow or action declares, and `Schema.Unknown`
 * last, for a member that declares none.
 *
 * A union encodes a failure through the first member that accepts it, so the
 * order is chosen, not inherited: member unions are flattened, catch-all
 * members (`Unknown`, `Any`, `Never`) are dropped, and tagged schemas, which
 * accept only their own `_tag`, come before untagged ones, which accept any
 * value of their shape. Two untagged schemas that accept the same shape still
 * encode as the first.
 *
 * @since 1.0.0
 * @private
 */
import * as Schema from "effect/Schema";
/**
 * The union a pattern hands `Flow.make` as its `error` schema.
 *
 * @since 1.0.0
 * @private
 */
export declare const schemaFor: (own: ReadonlyArray<Schema.Top>, members: ReadonlyArray<unknown>) => Schema.Top;
