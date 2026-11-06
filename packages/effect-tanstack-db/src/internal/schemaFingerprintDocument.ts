/**
 * The JSON Schema grouping used by deployed device identity locks.
 * @since 0.3.0
 */

import type * as JsonSchema from "effect/JsonSchema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Preserve the union grouping that deployed Effect 4.0.5 device locks hash.
 *
 * Effect 4.1 splices a member that is only an anyOf into its parent. A temporary
 * title keeps that member grouped during emission; the title is removed before
 * hashing. Only members which actually emit a bare anyOf receive it, so literal
 * enum compaction and authored annotations remain unchanged. The marker is
 * selected outside the original document's data, including defaults/examples.
 *
 * This is an identity adapter. Schema validation and displayed documents still
 * use the installed Effect implementation. It has no dependency on the flow SDK.
 * @since 0.3.0
 * @private
 */
export const toJsonSchemaDocument = (
  document: SchemaRepresentation.Document
): JsonSchema.Document<"draft-2020-12"> => {
  const original = SchemaRepresentation.toJsonSchemaDocument(document)
  const text = JSON.stringify(original)
  let marker = "smithers/device/union-grouping"
  while (text.includes(marker)) marker += "#"

  const protect = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(protect)
    if (!object(value)) return value
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        key === "annotations" || key === "payload" ? member : protect(member)
      ])
    )
    if (value["_tag"] === "Union" || value["_tag"] === "Enum") {
      const schema = SchemaRepresentation.toJsonSchemaDocument({
        representation: value as unknown as SchemaRepresentation.Union | SchemaRepresentation.Enum,
        references: document.references
      }).schema
      if (Object.keys(schema).length === 1 && Array.isArray(schema.anyOf)) {
        copy["annotations"] = { ...value["annotations"] as object, title: marker }
      }
    }
    return copy
  }

  const remove = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remove)
    if (!object(value)) return value
    return Object.fromEntries(
      Object.entries(value).filter(([key, member]) => key !== "title" || member !== marker)
        .map(([key, member]) => [key, remove(member)])
    )
  }
  return remove(SchemaRepresentation.toJsonSchemaDocument(
    {
      ...document,
      representation: protect(document.representation),
      references: Object.fromEntries(
        Object.entries(document.references).map(([identifier, representation]) => [identifier, protect(representation)])
      )
    } as SchemaRepresentation.Document
  )) as JsonSchema.Document<"draft-2020-12">
}
