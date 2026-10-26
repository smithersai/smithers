import { type JsonSchema, Option, Schema, type SchemaAST, SchemaRepresentation } from "effect"
import type { FormValues } from "./schema"

// The agent's forms (decision 0004 §3, docs/features/views.md#forms): the rules `ui/form`'s step and ChatApi share. A
// form's fields come from the JSON Schema the agent passed, read with Effect's JSON Schema importer, as `@smthrs/ui`'s
// `declaredInput` reads it for `FlowFormView`; its submission is checked against that very schema. This module runs in
// the engine worker and in ChatApi, so it imports no UI library.

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The schema as the `{ schema, definitions }` document `declaredInput` reads, as `FlowFormView` reads it. */
const documentOf = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  record(schema.schema) !== undefined
    ? schema
    : { schema, definitions: record(schema.$defs) ?? record(schema.definitions) ?? {} }

/** The form's input, as an Effect Schema, or `undefined` for a schema Effect's importer can't read. */
const inputOf = (schema: Readonly<Record<string, unknown>>): Schema.Top | undefined => {
  try {
    return SchemaRepresentation.fromJsonSchemaDocument(documentOf(schema) as unknown as JsonSchema.Document<"draft-2020-12">)
    // expected: a schema the importer can't read refuses the form
  } catch {
    return undefined
  }
}

/** Whether the input is an object, or a union of objects, with a field: what `FlowFormView` renders controls for. */
const hasFields = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Objects"
    ? ast.propertySignatures.length > 0
    : ast._tag === "Union" && ast.types.some(hasFields)

/** The properties a form's schema declares, whichever document shape it came in. */
const propertiesOf = (schema: Readonly<Record<string, unknown>>) =>
  record(record(documentOf(schema).schema)?.properties) ?? {}

/**
 * Why a form can't be shown:
 * - `no_fields`: its schema isn't an object schema with at least one field the form renders;
 * - `secret`: a field is write-only or a password. A form's values are the person's next question, synced to every
 *   device in the conversation, so it never asks for a secret: secrets are added in Settings and named, never typed.
 */
export const FORM_REFUSALS = ["no_fields", "secret"] as const
export type FormRefusal = (typeof FORM_REFUSALS)[number]

/**
 * Whether any schema anywhere in `value` is write-only or a password: a field's own, or one it reaches through `$ref`,
 * `$defs`, `allOf`, `anyOf` or `oneOf`. The whole document is searched, so no reference can hide one.
 */
const asksForSecret = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(asksForSecret)
  const node = record(value)
  if (node === undefined) return false
  return node.writeOnly === true || node.format === "password" || Object.values(node).some(asksForSecret)
}

/** Why the form with this schema can't be shown, or `undefined` when it can. */
export const formRefusal = (schema: Readonly<Record<string, unknown>>): FormRefusal | undefined => {
  if (asksForSecret(schema)) return "secret"
  const input = inputOf(schema)
  return input === undefined || !hasFields(input.ast) ? "no_fields" : undefined
}

/** The submitted values, when the form's own schema takes them; `undefined` otherwise. */
export const acceptedValues = (schema: Readonly<Record<string, unknown>>, values: FormValues): FormValues | undefined => {
  const input = inputOf(schema)
  if (input === undefined) return undefined
  const fields = new Set(Object.keys(propertiesOf(schema)))
  if (!Object.keys(values).every((name) => fields.has(name))) return undefined
  return Option.isSome(Schema.decodeUnknownOption(input as Schema.Codec<unknown>)(values)) ? values : undefined
}
