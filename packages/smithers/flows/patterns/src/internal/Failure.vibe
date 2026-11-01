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

import * as Schema from "effect/Schema"

const catchAll = (schema: Schema.Top): boolean => ["Unknown", "Any", "Never"].includes(schema.ast._tag)

const flatten = (schema: Schema.Top): ReadonlyArray<Schema.Top> => {
  const members = (schema as { readonly members?: unknown }).members
  return Array.isArray(members) ? members.flatMap((member: Schema.Top) => flatten(member)) : [schema]
}

const tagged = (schema: Schema.Top): boolean => {
  const fields = (schema as { readonly fields?: unknown }).fields
  return typeof fields === "object" && fields !== null && Object.hasOwn(fields, "_tag")
}

/** The error schema a member declares: a flow's or an action's, or none. */
const declaredBy = (member: unknown): Schema.Top | undefined => {
  if ((typeof member !== "object" && typeof member !== "function") || member === null) return undefined
  const schema = (member as { readonly errorSchema?: { readonly ast?: unknown } | undefined }).errorSchema
  return schema?.ast === undefined ? undefined : schema as unknown as Schema.Top
}

/**
 * The union a pattern hands `Flow.make` as its `error` schema.
 *
 * @since 1.0.0
 * @private
 */
export const schemaFor = (own: ReadonlyArray<Schema.Top>, members: ReadonlyArray<unknown>): Schema.Top => {
  const candidates: Array<Schema.Top> = []
  for (const schema of [...own, ...members.map(declaredBy)]) {
    if (schema === undefined) continue
    for (const member of flatten(schema)) {
      if (!catchAll(member) && !candidates.includes(member)) candidates.push(member)
    }
  }
  return Schema.Union([...candidates.filter(tagged), ...candidates.filter((schema) => !tagged(schema)), Schema.Unknown])
}
