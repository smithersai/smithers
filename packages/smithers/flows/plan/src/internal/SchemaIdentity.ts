/**
 * The schema identity projection: the JSON-Schema-shaped document a schema
 * contributes to a step key.
 *
 * A call node folds what its callee accepts and produces into the material a
 * step key is derived from, and a catch node folds its filter the same way. A
 * projection that printed differently under another `effect` release would
 * re-key every recorded step in every journal at once. `effect` is a peer
 * range, so the application picks the release; the projection therefore
 * cannot be the installed `Schema.toJsonSchemaDocument`. `effect@4.0.4`
 * already changed what that emitter prints for `Schema.Int`, `isMinLength`,
 * `isPattern`, repeated bounds, `oneOf` unions and shared definitions.
 *
 * This module owns the bytes instead. It reads the schema through two public
 * functions, `Schema.toCodecJson` and `Schema.toRepresentation`, and prints
 * the result with the emitter and the check fragments fixed below, which
 * reproduce `Schema.toJsonSchemaDocument(schema, options)` of
 * `effect@4.0.0-rc.115` for both values of `onExcessProperty`.
 *
 * It is for identity only. Where a JSON Schema is shown to a model or a
 * person, the installed emitter is the right one.
 *
 * One document departs from rc.115 on purpose. rc.115 printed a JSON string
 * (`Schema.fromJsonString`) as its media type alone, so two declarations that
 * decode different values shared an identity. A JSON string prints what it
 * decodes to as `contentSchema`, the way `effect@4.1.1` prints it. One built
 * with a `reviver` or a `replacer` still prints the media type alone: the
 * representation names no decoded schema for it, because the function can
 * change the value's shape.
 *
 * What still moves an identity, by design: a release that changes a schema's
 * JSON codec or its representation changes what the schema accepts on the
 * wire. Three limits follow from what the representation carries:
 *
 * - A built-in check contributes the constraint its id and payload name. A
 *   `toJsonSchema` annotation passed to a built-in check constructor is not
 *   consulted; one on a `makeFilter` check is.
 * - A built-in check this module does not list falls back to the installed
 *   check's own `toJsonSchema` annotation.
 * - `Schema.brand` is not part of the representation from `effect@4.0.4` on.
 *   Under rc.115 a schema that takes a definition (an `identifier` or a
 *   recursive schema) and appeared both branded and unbranded in one document
 *   got two definitions; it now gets one. The representation identity is
 *   versioned for this reason: see {@link representationIdentityVersions}.
 *
 * Provenance: {@link fromRepresentation} and its helpers are adapted from
 * `effect@4.0.0-rc.115` (MIT, Copyright (c) 2023 Effectful Technologies Inc;
 * the notice is in this package's `THIRD_PARTY_NOTICES.md`), files
 * `src/internal/schema/toJsonSchemaDocument.ts`, `src/JsonSchema.ts`
 * (`rewriteRefs`), `src/JsonPointer.ts` and `src/SchemaAST.ts` (`isJson`).
 * Changes: `onExcessProperty` is the only option; one root; a built-in
 * check's fragment comes from {@link builtinChecks}, not from
 * the installed annotation; an approximate check result contributes its
 * schema; a JSON string prints its `contentSchema`.
 *
 * @since 1.0.0
 */

import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

/** @private */
type Fragment = JsonSchema.JsonSchema

/** @private */
type Path = ReadonlyArray<string | number>

/** @private */
type Representation = SchemaRepresentation.Representation

/** @private */
type Check = SchemaRepresentation.Check

/** @private */
type CheckInput = SchemaRepresentation.ToJsonSchema.CheckInput

/**
 * The document a schema's identity is: exactly what rc.115 returned from
 * `Schema.toJsonSchemaDocument`, key order included.
 *
 * @since 1.0.0
 * @private
 */
export type Document = JsonSchema.Document<"draft-2020-12">

/**
 * How an object schema treats a key it does not declare, which is the one
 * emitter option a declaration's identity is taken under. It has rc.115's
 * meaning and rc.115's default: `"ignore"` leaves such keys open, `"error"`
 * closes them.
 *
 * @since 1.0.0
 * @private
 */
export interface Options {
  readonly onExcessProperty?: "ignore" | "error" | undefined
}

/**
 * A schema a step key cannot be derived from: one with no JSON Schema form or
 * no representation, or one whose built-in check the installed `effect`
 * describes differently from the releases this package supports. The message
 * is the one `effect@4.0.0-rc.115` gave for the same schema, where it gave one.
 *
 * @since 1.0.0
 * @category errors
 */
export class SchemaIdentityError extends Schema.TaggedError<SchemaIdentityError>()("@smthrs/plan/SchemaIdentityError", {
  message: Schema.String
}) {}

/** @private */
const invalid = (message: string, path: Path): SchemaIdentityError =>
  new SchemaIdentityError({
    message: path.length === 0
      ? message
      : `${message}\n  at ${path.map((key) => `[${typeof key === "string" ? JSON.stringify(key) : key}]`).join("")}`
  })

/** @private */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Assigns an own property, `__proto__` included: a struct may declare a field
 * by that name, and plain assignment would set the prototype instead.
 *
 * @private
 */
const assignProperty = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    target[key] = value
  }
}

/**
 * Whether a value is JSON: finite numbers, plain objects, no cycles. An
 * annotation that is not JSON never reaches the document.
 *
 * @private
 */
const isJson = (value: unknown, path: ReadonlySet<object> = new Set()): boolean => {
  if (typeof value !== "object" || value === null) {
    return value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
  }
  if (path.has(value)) return false
  const members = Array.isArray(value) ? Array.from<unknown>(value) : plainValues(value)
  if (members === undefined) return false
  const inner = new Set(path).add(value)
  return members.every((member) => isJson(member, inner))
}

/** @private */
const plainValues = (value: object): ReadonlyArray<unknown> | undefined => {
  const prototype: unknown = Object.getPrototypeOf(value)
  // A plain object from another realm has a different `Object.prototype`,
  // but that prototype still has a null prototype.
  return prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null
    ? Object.values(value)
    : undefined
}

/**
 * Structural equality of two emitted schemas, ignoring key order. `NaN`
 * equals itself: an author's fragment may carry one, and two definitions that
 * differ in nothing else are one definition.
 *
 * @private
 */
const sameJson = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((member, index) => sameJson(member, right[index]))
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  }
  return left === right || (left !== left && right !== right)
}

/** @private */
const escapeRegExp = (text: string): string => text.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")

/** @private */
const unescapeToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~")

/** @private */
const definitionReference = (key: string): string =>
  `#/$defs/${encodeURI(key.replace(/~/g, "~0").replace(/\//g, "~1")).replace(/#/g, "%23")}`

/**
 * The JSON Pointer a URI fragment names, or `undefined` when it names none.
 *
 * @private
 */
const decodeUriFragment = (fragment: string): string | undefined => {
  if (fragment.length === 0 || fragment === "#") return ""
  if (!fragment.startsWith("#")) return undefined
  const encoded = fragment.slice(1)
  try {
    if (encodeURI(encoded).replace(/%25/g, "%").replace(/#/g, "%23") !== encoded) return undefined
    const pointer = decodeURIComponent(encoded)
    return pointer.startsWith("/") && !/~(?:[^01]|$)/.test(pointer) ? pointer : undefined
  } catch {
    return undefined
  }
}

/**
 * Copies a schema, rewriting every `$ref` and `$dynamicRef` in a schema
 * position. Values that are data (`enum`, `const`, `default`, `examples`) are
 * not walked.
 *
 * @private
 */
const rewriteRefs = (node: Fragment, rewrite: (reference: string) => string): Fragment => {
  const walk = (value: unknown): unknown => isObject(value) ? rewriteRefs(value, rewrite) : value
  const out: Fragment = {}
  for (const key of Object.keys(node)) {
    const value = node[key]
    let transformed = value
    switch (key) {
      case "$defs":
      case "properties":
      case "patternProperties":
      case "dependentSchemas":
        if (isObject(value)) {
          const mapped: Fragment = {}
          for (const name of Object.keys(value)) assignProperty(mapped, name, walk(value[name]))
          transformed = mapped
        }
        break
      case "allOf":
      case "anyOf":
      case "oneOf":
      case "prefixItems":
        if (Array.isArray(value)) transformed = value.map(walk)
        break
      case "not":
      case "additionalProperties":
      case "propertyNames":
      case "unevaluatedProperties":
      case "items":
      case "contains":
      case "unevaluatedItems":
      case "if":
      case "then":
      case "else":
      case "contentSchema":
        transformed = walk(value)
    }
    assignProperty(out, key, transformed)
  }
  if (typeof out["$ref"] === "string") out["$ref"] = rewrite(out["$ref"])
  if (typeof out["$dynamicRef"] === "string") out["$dynamicRef"] = rewrite(out["$dynamicRef"])
  return out
}

/**
 * The annotations a JSON Schema states, in the order rc.115 printed them.
 *
 * @private
 */
const ordinaryAnnotations = (annotations: Schema.Annotations.Annotations | undefined): Fragment | undefined => {
  if (annotations === undefined) return undefined
  const out: Fragment = {}
  if (typeof annotations["title"] === "string") out["title"] = annotations["title"]
  if (typeof annotations["description"] === "string") out["description"] = annotations["description"]
  if (isJson(annotations["default"])) out["default"] = annotations["default"]
  if (Array.isArray(annotations["examples"]) && isJson(annotations["examples"])) {
    out["examples"] = annotations["examples"]
  }
  if (typeof annotations["readOnly"] === "boolean") out["readOnly"] = annotations["readOnly"]
  if (typeof annotations["writeOnly"] === "boolean") out["writeOnly"] = annotations["writeOnly"]
  if (typeof annotations["format"] === "string") out["format"] = annotations["format"]
  if (typeof annotations["contentEncoding"] === "string") out["contentEncoding"] = annotations["contentEncoding"]
  if (typeof annotations["contentMediaType"] === "string") out["contentMediaType"] = annotations["contentMediaType"]
  if (isJson(annotations["contentSchema"])) out["contentSchema"] = annotations["contentSchema"]
  return Object.keys(out).length === 0 ? undefined : out
}

/** @private */
const finitePattern = "[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?"

/** @private */
const stringPattern = "[\\s\\S]*?"

/** @private */
const bigIntPattern = "^-?\\d+$"

/** @private */
const symbolPattern = "^Symbol\\(([\\s\\S]*)\\)$"

/**
 * The key pattern of a `Schema.Number` record key: what `String(n)` prints for
 * every number. It is `numberKeyPattern` of `effect@4.1.1`'s
 * `src/internal/schema/toJsonSchemaDocument.ts`, built from that release's
 * `SchemaAST.FINITE_PATTERN`. rc.115 refused number keys, so no recorded
 * identity has one.
 *
 * @private
 */
const numberKeyPattern = "^(?:[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[Ee][+-]?\\d+)?|Infinity|-Infinity|NaN)$"

/** @private */
const uuidPattern = (version: number | null): string =>
  version === null
    ? "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|" +
      "00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"
    : `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`

/**
 * One field of a built-in check's payload. A release that renamed or retyped
 * it would otherwise print `undefined` into an identity, so it is refused.
 *
 * @private
 */
const field = <A>(id: string, payload: unknown, name: string, is: (value: unknown) => value is A): A => {
  const value = isObject(payload) ? payload[name] : undefined
  if (!is(value)) {
    throw new SchemaIdentityError({
      message: `Cannot derive a schema identity: check ${id} carries no usable "${name}" in its payload. ` +
        "The installed effect release describes this check differently from the releases @smthrs/plan supports."
    })
  }
  return value
}

/** @private */
const isNumber = (value: unknown): value is number => typeof value === "number"

/** @private */
const isString = (value: unknown): value is string => typeof value === "string"

/** @private */
const isVersion = (value: unknown): value is number | null => value === null || typeof value === "number"

/** @private */
const isFlag = (value: unknown): value is boolean | undefined => value === undefined || typeof value === "boolean"

/**
 * What a built-in check prints: its payload and the JSON type it refines in,
 * a fragment out. `null` is a check that prints nothing.
 *
 * @private
 */
type BuiltinCheck = ((id: string, payload: unknown, input: CheckInput) => Fragment) | null

/** @private */
const pattern = (source: string): BuiltinCheck => () => ({ pattern: source })

/** @private */
const literalPattern = (name: string, source: (escaped: string) => string): BuiltinCheck => (id, payload) => ({
  pattern: new RegExp(source(escapeRegExp(field(id, payload, name, isString)))).source
})

/** @private */
const bound = (keyword: string, name: string = keyword): BuiltinCheck => (id, payload) => ({
  [keyword]: field(id, payload, name, isNumber)
})

/** @private */
const length = (name: string, array: string, string: string): BuiltinCheck => (id, payload, input) => ({
  [input.type === "array" ? array : string]: field(id, payload, name, isNumber)
})

/** @private */
const empty: BuiltinCheck = () => ({})

/**
 * Every built-in check, keyed by the id its representation carries, with the
 * fragment `effect@4.0.0-rc.115` printed for it.
 *
 * The three code-point checks did not exist under rc.115; they print what
 * `effect@4.0.4` introduced them with. The date, big integer and size checks
 * print nothing but still carry their own annotations, which is what the
 * empty fragment keeps.
 *
 * @private
 */
const builtinChecks: ReadonlyMap<string, BuiltinCheck> = new Map<string, BuiltinCheck>([
  ["effect/schema/isAscii", pattern("^[\\x00-\\x7F]*$")],
  ["effect/schema/isTrimmed", pattern("^\\S[\\s\\S]*\\S$|^\\S$|^$")],
  ["effect/schema/isPattern", (id, payload) => ({ pattern: field(id, payload, "source", isString) })],
  ["effect/schema/isStringFinite", pattern(`^${finitePattern}$`)],
  ["effect/schema/isStringBigInt", pattern(bigIntPattern)],
  ["effect/schema/isStringSymbol", pattern(symbolPattern)],
  ["effect/schema/isUUID", (id, payload) => ({
    pattern: uuidPattern(field(id, payload, "version", isVersion)),
    format: "uuid"
  })],
  ["effect/schema/isGUID", pattern("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$")],
  ["effect/schema/isULID", pattern("^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$")],
  ["effect/schema/isBase64", pattern("^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$")],
  ["effect/schema/isBase64Url", pattern("^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$")],
  ["effect/schema/isStartingWith", literalPattern("startsWith", (escaped) => `^${escaped}`)],
  ["effect/schema/isEndingWith", literalPattern("endsWith", (escaped) => `${escaped}$`)],
  ["effect/schema/isIncluding", literalPattern("includes", (escaped) => escaped)],
  ["effect/schema/isUppercased", pattern("^[^a-z]*$")],
  ["effect/schema/isLowercased", pattern("^[^A-Z]*$")],
  ["effect/schema/isCapitalized", pattern("^(?:[^a-z][\\s\\S]*)?$")],
  ["effect/schema/isUncapitalized", pattern("^(?:[^A-Z][\\s\\S]*)?$")],
  ["effect/schema/isFinite", () => ({ type: "number" })],
  ["effect/schema/isInt", () => ({ type: "integer" })],
  ["effect/schema/isGreaterThan", bound("exclusiveMinimum")],
  ["effect/schema/isGreaterThanOrEqualTo", bound("minimum")],
  ["effect/schema/isLessThan", bound("exclusiveMaximum")],
  ["effect/schema/isLessThanOrEqualTo", bound("maximum")],
  ["effect/schema/isBetween", (id, payload) => ({
    [field(id, payload, "exclusiveMinimum", isFlag) ? "exclusiveMinimum" : "minimum"]: field(
      id,
      payload,
      "minimum",
      isNumber
    ),
    [field(id, payload, "exclusiveMaximum", isFlag) ? "exclusiveMaximum" : "maximum"]: field(
      id,
      payload,
      "maximum",
      isNumber
    )
  })],
  ["effect/schema/isMultipleOf", bound("multipleOf", "divisor")],
  ["effect/schema/isGreaterThanDate", empty],
  ["effect/schema/isGreaterThanOrEqualToDate", empty],
  ["effect/schema/isLessThanDate", empty],
  ["effect/schema/isLessThanOrEqualToDate", empty],
  ["effect/schema/isBetweenDate", empty],
  ["effect/schema/isGreaterThanBigInt", empty],
  ["effect/schema/isGreaterThanOrEqualToBigInt", empty],
  ["effect/schema/isLessThanBigInt", empty],
  ["effect/schema/isLessThanOrEqualToBigInt", empty],
  ["effect/schema/isBetweenBigInt", empty],
  ["effect/schema/isMinLength", length("minLength", "minItems", "minLength")],
  ["effect/schema/isMaxLength", length("maxLength", "maxItems", "maxLength")],
  ["effect/schema/isBetweenLength", (id, payload, input) => {
    const minimum = field(id, payload, "minimum", isNumber)
    const maximum = field(id, payload, "maximum", isNumber)
    return input.type === "array"
      ? { allOf: [{ minItems: minimum }, { maxItems: maximum }] }
      : { allOf: [{ minLength: minimum }, { maxLength: maximum }] }
  }],
  ["effect/schema/isMinCodePoints", bound("minLength", "minCodePoints")],
  ["effect/schema/isMaxCodePoints", bound("maxLength", "maxCodePoints")],
  ["effect/schema/isBetweenCodePoints", (id, payload) => ({
    allOf: [
      { minLength: field(id, payload, "minimum", isNumber) },
      { maxLength: field(id, payload, "maximum", isNumber) }
    ]
  })],
  ["effect/schema/isMinSize", empty],
  ["effect/schema/isMaxSize", empty],
  ["effect/schema/isBetweenSize", empty],
  ["effect/schema/isMinProperties", bound("minProperties")],
  ["effect/schema/isMaxProperties", bound("maxProperties")],
  ["effect/schema/isBetweenProperties", (id, payload) => ({
    minProperties: field(id, payload, "minimum", isNumber),
    maxProperties: field(id, payload, "maximum", isNumber)
  })],
  ["effect/schema/isPropertyNames", (_id, _payload, input) => ({ propertyNames: input.schemas[0] })],
  ["effect/schema/isUnique", () => ({ uniqueItems: true })],
  ["effect/schema/isUniqueKey", null]
])

/**
 * The ids {@link builtinChecks} lists, for the test that holds the list
 * against the checks the installed `effect` can revive.
 *
 * @since 1.0.0
 * @private
 */
export const builtinCheckIds: ReadonlyArray<string> = [...builtinChecks.keys()]

/** @private */
const isCheckCallback = (value: unknown): value is SchemaRepresentation.ToJsonSchema.Check =>
  typeof value === "function"

/** @private */
const isApproximate = (
  output: SchemaRepresentation.ToJsonSchema.CheckOutput
): output is readonly [schema: Fragment, approximate: true] => Array.isArray(output)

/**
 * What prints a check, if anything does: the owned fragment for a built-in
 * check, otherwise the author's own `toJsonSchema` annotation.
 *
 * @private
 */
const fragmentSource = (check: Check): ((input: CheckInput) => Fragment) | undefined => {
  const representation = check.representation
  const builtin = representation === undefined ? undefined : builtinChecks.get(representation.id)
  if (representation !== undefined && builtin !== undefined) {
    return builtin === null ? undefined : (input) => builtin(representation.id, representation.payload, input)
  }
  const callback = check.annotations?.["toJsonSchema"]
  if (!isCheckCallback(callback)) return undefined
  return (input) => {
    const output = callback(input)
    return isApproximate(output) ? output[0] : output
  }
}

/** @private */
type NumberType = "number" | "integer"

/** @private */
const extractNumberType = (schema: Fragment): { readonly type: NumberType | undefined; readonly schema: Fragment } => {
  let type: NumberType | undefined = schema["type"] === "number" || schema["type"] === "integer"
    ? schema["type"]
    : undefined
  let out = schema
  if (type !== undefined) {
    out = { ...schema }
    delete out["type"]
  }
  const allOf = out["allOf"]
  if (Array.isArray(allOf)) {
    const members: Array<Fragment> = []
    let changed = false
    for (const member of allOf) {
      const extracted = extractNumberType(member)
      if (extracted.type !== undefined) {
        changed = true
        if (type === undefined || extracted.type === "integer") type = extracted.type
      }
      if (Object.keys(extracted.schema).length > 0) members.push(extracted.schema)
    }
    if (changed) {
      const { allOf: _, ...rest } = out
      out = members.length === 0 ? rest : { ...rest, allOf: members }
    }
  }
  return { type, schema: out }
}

/** @private */
const isNumberEncoding = (schema: Fragment): boolean => {
  const anyOf = schema["anyOf"]
  if (!Array.isArray(anyOf) || anyOf.length !== 2 || !isObject(anyOf[0]) || anyOf[0]["type"] !== "number") return false
  const special: unknown = anyOf[1]
  if (!isObject(special) || special["type"] !== "string") return false
  const values = special["enum"]
  return Array.isArray(values) && values.length === 3 && values.includes("NaN") && values.includes("Infinity") &&
    values.includes("-Infinity")
}

// Keep this allowlist closed: applicators and dependent keywords can change meaning when moved across schema objects.
/** @private */
const inlineableCheckKeywords =
  "|type|format|pattern|multipleOf|minimum|maximum|exclusiveMinimum|exclusiveMaximum|minLength|maxLength|minItems|maxItems|uniqueItems|minProperties|maxProperties|propertyNames|"

// `format` and `content*` can affect validation, so they are not treated as pure annotations.
/** @private */
const promotableAnnotationKeywords = "|title|description|default|examples|readOnly|writeOnly|"

/** @private */
const inlineableAnnotatedCheckKeywords = inlineableCheckKeywords + promotableAnnotationKeywords

/** @private */
const hasOnlyKeywords = (schema: Fragment, allowed: string): boolean =>
  Object.keys(schema).every((key) => allowed.includes(`|${key}|`))

/** @private */
const hasNoCollisions = (left: Fragment, rightKeys: ReadonlyArray<string>): boolean =>
  typeof left["$ref"] !== "string" && rightKeys.every((key) => !Object.hasOwn(left, key))

/**
 * Adds a constraint to a schema: inline when no keyword collides, otherwise
 * under `allOf`. A repeated bound is never merged into the tighter one.
 *
 * @private
 */
const appendJsonSchema = (left: Fragment, right: Fragment, inlineCheck?: true): Fragment => {
  if (Object.keys(left).length === 0) return right
  const rightKeys = Object.keys(right)
  if (rightKeys.length === 0) return left
  const leftType = left["type"] === "number" || left["type"] === "integer" ? left["type"] : undefined
  const numberEncoding = isNumberEncoding(left)
  if (leftType !== undefined || numberEncoding) {
    const extracted = extractNumberType(right)
    if (extracted.type !== undefined) {
      const type = leftType === "integer" || extracted.type === "integer" ? "integer" : "number"
      const base: Fragment = { ...left, type }
      if (numberEncoding) delete base["anyOf"]
      const extractedKeys = Object.keys(extracted.schema)
      if (extractedKeys.length === 0) return base
      return hasOnlyKeywords(extracted.schema, promotableAnnotationKeywords) && hasNoCollisions(base, extractedKeys)
        ? { ...base, ...extracted.schema }
        : appendJsonSchema(base, extracted.schema, inlineCheck)
    }
  }
  if (inlineCheck && hasNoCollisions(left, rightKeys)) return { ...left, ...right }
  const rightAllOf = right["allOf"]
  const members: ReadonlyArray<unknown> = Array.isArray(rightAllOf) && rightKeys.length === 1 ? rightAllOf : [right]
  const leftAllOf = left["allOf"]
  if (Array.isArray(leftAllOf)) return { ...left, allOf: [...leftAllOf, ...members] }
  if (typeof left["$ref"] === "string") return { allOf: [left, ...members] }
  return { ...left, allOf: members }
}

/** @private */
const jsonSchemaTypes: ReadonlySet<unknown> = new Set([
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "null",
  "integer"
])

/** @private */
const isJsonSchemaType = (input: unknown): input is JsonSchema.Type => jsonSchemaTypes.has(input)

/**
 * Collapses a union of single-type enums into one enum, the way a union of
 * literals reads.
 *
 * @private
 */
const compactEnums = (schemas: ReadonlyArray<Fragment>): Fragment | undefined => {
  let sharedType: unknown = undefined
  const values: Array<unknown> = []
  for (const schema of schemas) {
    const members = schema["enum"]
    if (
      Object.keys(schema).length !== 2 || schema["type"] === undefined || !Array.isArray(members) ||
      members.length === 0
    ) {
      return undefined
    }
    if (sharedType === undefined) sharedType = schema["type"]
    else if (schema["type"] !== sharedType) return undefined
    for (const value of members) {
      if (values.includes(value)) return undefined
      values.push(value)
    }
  }
  return { type: sharedType, enum: values }
}

/** @private */
const partPattern = (part: Representation): string => {
  switch (part._tag) {
    case "Literal":
      return escapeRegExp(String(part.literal))
    case "String":
      return stringPattern
    case "Number":
      return finitePattern
    case "TemplateLiteral":
      return part.parts.map(partPattern).join("")
    case "Union":
      return `(?:${part.types.map(partPattern).join("|")})`
    default:
      throw invalid("Invalid schema representation document", [])
  }
}

/** @private */
const neverSchema: Fragment = { not: {} }

/**
 * Refuses a representation kind this module does not print. A later `effect`
 * release that adds one fails here by name, not as a missing property.
 *
 * @private
 */
const unsupported = (representation: never, path: Path): never => {
  throw invalid(`Unsupported schema representation ${(representation as { readonly _tag: string })._tag}`, path)
}

/**
 * Prints a representation document as the JSON Schema document rc.115
 * printed for it under the same options.
 *
 * Reserved for {@link schemaIdentity} and for the tests that hand it a
 * representation no schema produces.
 *
 * @since 1.0.0
 * @private
 */
export const fromRepresentation = (document: SchemaRepresentation.Document, options?: Options): Document => {
  const closed = options?.onExcessProperty === "error"
  const references = document.references
  // A key maps to its compiled schema, to the key it is an alias of, or to
  // `null` while it is compiling.
  const definitionStates = new Map<string, Fragment | string | null>()
  const compiledRepresentations = new WeakMap<Representation, Fragment>()
  const fallbackDefinitions = new Map<string, Array<string>>()

  const compileDefinition = (key: string, path: Path): string => {
    const compiled = definitionStates.get(key)
    if (compiled !== undefined) return typeof compiled === "string" ? compiled : key
    const representation = Object.hasOwn(references, key) ? references[key] : undefined
    if (representation === undefined) throw invalid(`Invalid reference ${key}`, [...path, "$ref"])

    definitionStates.set(key, null)
    const schema = recur(representation, ["references", key])

    const fallback = identifierFallback(representation)
    if (fallback !== undefined) {
      const candidates = fallbackDefinitions.get(fallback)
      const match = candidates?.find((candidate) => sameJson(definitionStates.get(candidate), schema))
      if (match === undefined) {
        if (candidates === undefined) fallbackDefinitions.set(fallback, [key])
        else candidates.push(key)
      } else {
        definitionStates.set(key, match)
        return match
      }
    }
    definitionStates.set(key, schema)
    return key
  }

  const finalize = (schema: Fragment): Fragment =>
    rewriteRefs(schema, (reference) => {
      const pointer = decodeUriFragment(reference)
      if (pointer === undefined) {
        if (/^#(?:\/|%2f)/i.test(reference)) {
          throw new SchemaIdentityError({ message: `Invalid JSON Pointer URI fragment ${JSON.stringify(reference)}` })
        }
        return reference
      }
      if (!pointer.startsWith("/$defs/")) return reference
      const separator = pointer.indexOf("/", 7)
      const canonical = definitionStates.get(unescapeToken(pointer.slice(7, separator < 0 ? undefined : separator)))
      if (typeof canonical !== "string") return reference
      // URI-encoded slashes separate pointer tokens; only ~1 represents a slash within a token.
      return reference.replace(/^#(?:\/|%2f).*?(?:\/|%2f).*?(?=\/|%2f|$)/i, definitionReference(canonical))
    })

  const identifierFallback = (representation: Representation): string | undefined => {
    if (representation._tag === "Reference") return undefined
    const last = representation.checks.at(-1)
    const annotations = last === undefined ? representation.annotations : last.annotations
    const fallback = annotations?.["~identifier"]
    return typeof annotations?.["identifier"] !== "string" && typeof fallback === "string" ? fallback : undefined
  }

  const compileCheck = (
    check: Check,
    type: JsonSchema.Type | undefined,
    path: Path
  ): readonly [schema: Fragment, inline?: true] | undefined => {
    const source = fragmentSource(check)
    if (source !== undefined) {
      const schemas = check.representation?.schemas?.map((schema, index) =>
        recur(schema, [...path, "representation", "schemas", index])
      ) ?? []
      const fragment = source({ type, schemas })
      const ordinary = ordinaryAnnotations(check.annotations)
      const schema = ordinary === undefined ? fragment : { ...fragment, ...ordinary }
      const allowed = ordinary === undefined ? inlineableCheckKeywords : inlineableAnnotatedCheckKeywords
      return check._tag === "Filter" && hasOnlyKeywords(schema, allowed) &&
          (ordinary === undefined || hasOnlyKeywords(ordinary, promotableAnnotationKeywords))
        ? [schema, true]
        : [schema]
    }
    if (check._tag === "Filter") return undefined

    const allOf: Array<Fragment> = []
    check.checks.forEach((child, index) => {
      const compiled = compileCheck(child, type, [...path, "checks", index])
      if (compiled !== undefined) allOf.push(compiled[0])
    })
    if (allOf.length === 0) return undefined
    const ordinary = ordinaryAnnotations(check.annotations)
    return [ordinary === undefined ? { allOf } : { allOf, ...ordinary }]
  }

  const recur = (representation: Representation, path: Path): Fragment => {
    if (representation._tag === "Reference") {
      return { $ref: definitionReference(compileDefinition(representation.$ref, path)) }
    }
    const cached = compiledRepresentations.get(representation)
    if (cached !== undefined) return cached

    let output = on(representation, path)
    const ordinary = ordinaryAnnotations(representation.annotations)
    if (ordinary !== undefined) output = { ...output, ...ordinary }
    const content = representation._tag === "String" ? representation.content : undefined
    if (content?.mediaType === "application/json" && content.schema !== undefined) {
      // What the string decodes to is part of what the schema accepts. As in
      // effect@4.1.1, it takes the place of an author's `contentSchema`
      // annotation and prints after the other annotations.
      const { contentSchema: _, ...rest } = output
      output = { ...rest, contentSchema: recur(content.schema, [...path, "content", "schema"]) }
    }
    representation.checks.forEach((check, index) => {
      const compiled = compileCheck(
        check,
        isJsonSchemaType(output["type"]) ? output["type"] : undefined,
        [...path, "checks", index]
      )
      if (compiled !== undefined) output = appendJsonSchema(output, ...compiled)
    })
    compiledRepresentations.set(representation, output)
    return output
  }

  const annotated = (compiled: Fragment, annotations: Schema.Annotations.Annotations | undefined): Fragment => {
    const ordinary = ordinaryAnnotations(annotations)
    return ordinary === undefined ? compiled : appendJsonSchema(compiled, ordinary)
  }

  const on = (representation: Exclude<Representation, SchemaRepresentation.Reference>, path: Path): Fragment => {
    switch (representation._tag) {
      case "Any":
      case "Unknown":
      case "Declaration":
        return {}
      case "ObjectKeyword":
        return { anyOf: [{ type: "object" }, { type: "array" }] }
      case "Void":
      case "Undefined":
      case "Null":
        return { type: "null" }
      case "BigInt":
        return { type: "string", allOf: [{ pattern: bigIntPattern }] }
      case "Symbol":
        return { type: "string", allOf: [{ pattern: symbolPattern }] }
      case "UniqueSymbol":
        return Symbol.keyFor(representation.symbol) === undefined
          ? { not: {} }
          : { type: "string", enum: [String(representation.symbol)] }
      case "Suspend":
        return recur(representation.thunk, [...path, "thunk"])
      case "Never":
        return { not: {} }
      case "String":
        // Effect 4.1 moves fromJsonString's media type out of annotations.
        // This emitter owns the older durable identity, not runtime validation.
        // `recur` adds the schema the string decodes to.
        return representation.content?.mediaType === "application/json"
          ? { type: "string", contentMediaType: "application/json" }
          : { type: "string" }
      case "Number":
        return { anyOf: [{ type: "number" }, { type: "string", enum: ["NaN", "Infinity", "-Infinity"] }] }
      case "Boolean":
        return { type: "boolean" }
      case "Literal": {
        const literal = representation.literal
        return typeof literal === "bigint"
          ? { type: "string", enum: [String(literal)] }
          : { type: typeof literal, enum: [literal] }
      }
      case "Enum": {
        const types = representation.enums.map(([title, literal], index) => {
          if (typeof literal === "number" && !Number.isFinite(literal)) {
            throw invalid(`Invalid numeric enum value ${String(literal)}`, [...path, "enums", index, 1])
          }
          return { type: typeof literal, enum: [literal], title }
        })
        return types.length === 0 ? { not: {} } : { anyOf: types }
      }
      case "TemplateLiteral":
        return { type: "string", pattern: `^${representation.parts.map(partPattern).join("")}$` }
      case "Arrays": {
        const rest = representation.rest[0]
        if (representation.rest.length > 1) {
          throw invalid("Invalid schema representation document", [...path, "rest"])
        }
        const out: Fragment = { type: "array" }
        let minItems = representation.elements.length
        const prefixItems = representation.elements.map((element, index) => {
          if (element.isOptional) minItems--
          return annotated(recur(element.type, [...path, "elements", index, "type"]), element.annotations)
        })
        if (prefixItems.length > 0) {
          out["prefixItems"] = prefixItems
          out["maxItems"] = representation.elements.length
          if (minItems > 0) out["minItems"] = minItems
        } else {
          out["items"] = false
        }
        if (rest !== undefined) {
          delete out["maxItems"]
          const items = recur(rest, [...path, "rest", 0])
          if (Object.keys(items).length > 0) out["items"] = items
          else delete out["items"]
        }
        return out
      }
      case "Objects": {
        if (representation.propertySignatures.length === 0 && representation.indexSignatures.length === 0) {
          return { not: { type: "null" } }
        }
        const out: Fragment = { type: "object" }
        const properties: Record<string, Fragment> = {}
        const required: Array<string> = []
        representation.propertySignatures.forEach((property, index) => {
          const name = property.name
          if (typeof name !== "string") {
            throw invalid("Invalid schema representation document", [...path, "propertySignatures", index, "name"])
          }
          assignProperty(
            properties,
            name,
            annotated(recur(property.type, [...path, "propertySignatures", index, "type"]), property.annotations)
          )
          if (!property.isOptional) required.push(name)
        })
        if (representation.propertySignatures.length > 0) out["properties"] = properties
        if (required.length > 0) out["required"] = required
        const patternProperties: Record<string, Fragment | false> = {}
        const additionalPropertySchemas: Array<Fragment | false> = []
        const indexValueSchemas: Array<Fragment | false> = []
        let hasUnrepresentableIndexPattern = false
        const numberKeyed: Array<boolean> = []
        representation.indexSignatures.forEach((signature, index) => {
          const compiled = recur(signature.type, [...path, "indexSignatures", index, "type"])
          const type = sameJson(compiled, neverSchema) ? false : compiled
          indexValueSchemas.push(type)
          const walk = { numberKey: false }
          const patterns = parameterPatterns(
            signature.parameter,
            [...path, "indexSignatures", index, "parameter"],
            new Set(),
            walk
          )
          numberKeyed.push(walk.numberKey)
          if (patterns === undefined) {
            hasUnrepresentableIndexPattern = true
          } else if (patterns.length === 0) {
            additionalPropertySchemas.push(type)
          } else {
            for (const key of patterns) {
              const previous = Object.hasOwn(patternProperties, key) ? patternProperties[key] : undefined
              assignProperty(
                patternProperties,
                key,
                previous === undefined
                  ? type
                  : previous === false || type === false
                  ? false
                  : appendJsonSchema(previous, type)
              )
            }
          }
        })
        const hasPatternProperties = Object.keys(patternProperties).length > 0
        if (hasPatternProperties) out["patternProperties"] = patternProperties
        const additional = additionalPropertySchemas.map((type) => ({ type: "object", additionalProperties: type }))
        if (hasUnrepresentableIndexPattern && closed) {
          const propertyNames: Array<Fragment> = []
          if (representation.propertySignatures.length > 0) propertyNames.push({ enum: Object.keys(properties) })
          representation.indexSignatures.forEach((signature, index) => {
            const parameterPath = [...path, "indexSignatures", index, "parameter"]
            propertyNames.push(
              numberKeyed[index]
                ? propertyNameSchema(signature.parameter, parameterPath, new Set())
                : recur(signature.parameter, parameterPath)
            )
          })
          out["propertyNames"] = propertyNames.length === 1 ? propertyNames[0] : { anyOf: propertyNames }
          out["additionalProperties"] = indexValueSchemas.length === 1
            ? indexValueSchemas[0]
            : { anyOf: indexValueSchemas }
          if (additional.length > 0) out["allOf"] = additional
        } else if (additional.length === 0) {
          out["additionalProperties"] = hasUnrepresentableIndexPattern || !closed
        } else if (
          additionalPropertySchemas.length === 1 && representation.propertySignatures.length === 0 &&
          !hasPatternProperties
        ) {
          out["additionalProperties"] = additionalPropertySchemas[0]
        } else {
          out["allOf"] = additional
        }
        const additionalProperties = out["additionalProperties"]
        if (isObject(additionalProperties) && Object.keys(additionalProperties).length === 0) {
          delete out["additionalProperties"]
        }
        return out
      }
      case "Union": {
        const types = representation.types.map((type, index) => recur(type, [...path, "types", index]))
        if (types.length === 0) return { not: {} }
        const mode = representation.options?.mode ?? "anyOf"
        if (mode === "anyOf" && types.length > 1) {
          const compacted = compactEnums(types)
          if (compacted !== undefined) return compacted
        }
        return mode === "anyOf" ? { anyOf: types } : { oneOf: types }
      }
      default:
        return unsupported(representation, path)
    }
  }

  // The property names of a closed record whose key walk met a number key, as
  // effect@4.1.1's `getPropertyNameSchema` prints them. rc.115 refused every
  // such key, so a signature that never meets one keeps rc.115's form.
  const propertyNameSchema = (
    parameter: Representation,
    path: Path,
    seenReferences: ReadonlySet<string>
  ): Fragment => {
    switch (parameter._tag) {
      case "Number":
        return { type: "string", pattern: numberKeyPattern }
      case "Reference": {
        if (seenReferences.has(parameter.$ref)) return { type: "string" }
        const target = Object.hasOwn(references, parameter.$ref) ? references[parameter.$ref] : undefined
        if (target === undefined) throw invalid(`Invalid reference ${parameter.$ref}`, [...path, "$ref"])
        return propertyNameSchema(target, ["references", parameter.$ref], new Set(seenReferences).add(parameter.$ref))
      }
      case "Union":
        return {
          anyOf: parameter.types.map((type, index) =>
            propertyNameSchema(type, [...path, "types", index], seenReferences)
          )
        }
      default:
        return recur(parameter, path)
    }
  }

  // `walk.numberKey` records whether the walk met a number key.
  const parameterPatterns = (
    parameter: Representation,
    path: Path,
    seenReferences: ReadonlySet<string>,
    walk: { numberKey: boolean }
  ): ReadonlyArray<string> | undefined => {
    switch (parameter._tag) {
      case "Number":
        walk.numberKey = true
        return parameter.checks.length === 0 ? [numberKeyPattern] : undefined
      case "Reference": {
        const target = Object.hasOwn(references, parameter.$ref) ? references[parameter.$ref] : undefined
        if (target === undefined) throw invalid(`Invalid reference ${parameter.$ref}`, [...path, "$ref"])
        compileDefinition(parameter.$ref, path)
        if (seenReferences.has(parameter.$ref)) return undefined
        return parameterPatterns(
          target,
          ["references", parameter.$ref],
          new Set(seenReferences).add(parameter.$ref),
          walk
        )
      }
      case "String": {
        // A key that is a JSON string has no pattern. Without one the key
        // prints among the property names, with what it decodes to.
        if (parameter.content?.mediaType === "application/json" && parameter.content.schema !== undefined) {
          return undefined
        }
        const check = parameter.checks[0]
        if (check === undefined) return []
        if (parameter.checks.length !== 1 || check._tag !== "Filter" || fragmentSource(check) === undefined) {
          return undefined
        }
        const schema = recur(parameter, path)
        const key = schema["pattern"]
        return schema["type"] === "string" && typeof key === "string" &&
            hasOnlyKeywords(schema, "|type|pattern|title|description|default|examples|readOnly|writeOnly|")
          ? [key]
          : undefined
      }
      case "TemplateLiteral":
        return parameter.checks.length === 0 ? [`^${parameter.parts.map(partPattern).join("")}$`] : undefined
      case "Union": {
        if (parameter.types.length === 0 || parameter.checks.length > 0 || parameter.options?.mode === "oneOf") {
          return undefined
        }
        const patterns: Array<string> = []
        for (const [index, member] of parameter.types.entries()) {
          const memberPatterns = parameterPatterns(member, [...path, "types", index], seenReferences, walk)
          if (memberPatterns === undefined) return undefined
          if (memberPatterns.length === 0) return []
          patterns.push(...memberPatterns)
        }
        return patterns
      }
      default:
        throw invalid(`Unsupported index key type ${parameter._tag}`, path)
    }
  }

  const referenceKeys = Object.keys(references)
  for (const key of referenceKeys) compileDefinition(key, ["references", key])
  const schema = finalize(recur(document.representation, ["representation"]))
  const definitions: Record<string, Fragment> = {}
  for (const key of referenceKeys) {
    const compiled = definitionStates.get(key)
    if (isObject(compiled)) assignProperty(definitions, key, finalize(compiled))
  }
  return { dialect: "draft-2020-12", schema, definitions }
}

/**
 * The identity a schema contributes: a pure function of the schema and the
 * option, and of nothing the installed `effect` release prints. It takes the
 * place of `Schema.toJsonSchemaDocument(schema, options)` wherever the
 * document is hashed, compared or pinned.
 *
 * Throws what rc.115 threw for a schema with no JSON Schema form: more than
 * one rest element, a `toJsonSchema` annotation that throws. A record key
 * that is not a string, a number, a template or a union of them is refused by
 * name. A number key, which rc.115 refused, prints as `effect@4.1.1` prints
 * it.
 *
 * @since 1.0.0
 * @private
 */
export const schemaIdentity = (schema: Schema.Top, options?: Options): Document =>
  fromRepresentation(Schema.toRepresentation(Schema.toCodecJson(schema)), options)

/**
 * The six built-in checks `effect` renamed after `4.0.0-rc.115`, from the id
 * a later release writes to the id rc.115 wrote. Their payloads and
 * payloads did not change. The 4.1 default annotations are projected separately.
 *
 * @private
 */
const rc115CheckIds: ReadonlyMap<string, string> = new Map([
  ["effect/schema/isStartingWith", "effect/schema/isStartsWith"],
  ["effect/schema/isEndingWith", "effect/schema/isEndsWith"],
  ["effect/schema/isIncluding", "effect/schema/isIncludes"],
  ["effect/schema/isBetweenLength", "effect/schema/isLengthBetween"],
  ["effect/schema/isBetweenSize", "effect/schema/isSizeBetween"],
  ["effect/schema/isBetweenProperties", "effect/schema/isPropertiesLengthBetween"]
])

/** The default check annotations that changed in 4.1, projected to rc.115 bytes. */
const rc115CheckPatterns = new Map([
  ["effect/schema/isStringFinite", {
    current: "^[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[Ee][+-]?\\d+)?$",
    flags: "",
    previous: `^${finitePattern}$`
  }],
  ["effect/schema/isGUID", {
    current: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
    flags: "u",
    previous: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"
  }],
  ["effect/schema/isULID", {
    current: "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$",
    flags: "u",
    previous: "^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$"
  }]
])

/** Keeps author overrides while restoring only the changed built-in defaults. */
const withRc115CheckAnnotations = (check: Record<string, unknown>, annotations: Schema.Json): Schema.Json => {
  const representation = check["representation"]
  if (!isObject(representation) || typeof representation["id"] !== "string") return annotations
  const patterns = rc115CheckPatterns.get(representation["id"])
  if (patterns === undefined || !isObject(annotations)) return annotations
  const constraint = annotations["arbitraryConstraint"]
  if (!isObject(constraint) || !Array.isArray(constraint["patterns"])) return annotations
  const entries = constraint["patterns"]
  if (
    entries.length !== 1 || !isObject(entries[0]) || entries[0]["source"] !== patterns.current ||
    entries[0]["flags"] !== patterns.flags
  ) return annotations
  return {
    ...annotations,
    ...(annotations["expected"] === `a string matching the RegExp ${patterns.current}`
      ? { expected: `a string matching the RegExp ${patterns.previous}` }
      : {}),
    arbitraryConstraint: {
      ...constraint as Record<string, Schema.Json>,
      patterns: [{ ...entries[0] as Record<string, Schema.Json>, source: patterns.previous, flags: "" }]
    }
  }
}

/**
 * A copy of an encoded representation with every renamed check id written
 * back as rc.115 wrote it. Only an element of a `checks` array is a check.
 * Author annotations and payloads are preserved. Known 4.1 built-in pattern
 * defaults are projected to their older identity forms. Key order is kept, so
 * the recorded bytes match.
 *
 * `content` says what a JSON string contributes. `"mediaType"` projects its
 * content metadata to the rc.115 form, a `contentMediaType` annotation and
 * nothing about the decoded schema, which versions 2 and 1 hashed. `"schema"`
 * keeps the member as the installed release encodes it, decoded schema
 * included.
 *
 * @private
 */
const withRc115CheckIds = (value: Schema.Json, content: "mediaType" | "schema", isCheck = false): Schema.Json => {
  if (Array.isArray(value)) return value.map((member) => withRc115CheckIds(member, content, isCheck))
  if (!isObject(value)) return value
  const out: Record<string, Schema.Json> = {}
  const projected = content === "mediaType" && value["_tag"] === "String" && isObject(value["content"]) &&
    value["content"]["mediaType"] === "application/json"
  for (const [key, member] of Object.entries(value as Readonly<Record<string, Schema.Json>>)) {
    if (key === "content" && projected) continue
    if (key === "annotations" || key === "payload") {
      const annotations = key === "annotations" && projected && isObject(member)
        ? { ...member, contentMediaType: "application/json" }
        : member
      assignProperty(
        out,
        key,
        key === "annotations" && isCheck ? withRc115CheckAnnotations(value, annotations) : annotations
      )
      continue
    }
    const renamed = isCheck && key === "representation" && isObject(member) && typeof member["id"] === "string"
      ? rc115CheckIds.get(member["id"])
      : undefined
    assignProperty(
      out,
      key,
      renamed === undefined
        ? withRc115CheckIds(member, content, key === "checks")
        : withRc115CheckIds({ ...(member as Readonly<Record<string, Schema.Json>>), id: renamed }, content)
    )
  }
  return out
}

/**
 * The versions of a representation identity, newest first. A sealed action's
 * step key hashes one, and a key written under an older version must stay
 * derivable, so a version is never changed once published; a change adds a
 * version at the front.
 *
 * - `3`, the current version, written since 2026-11-11: version 2 with what a
 *   JSON string (`Schema.fromJsonString`) decodes to. The string keeps the
 *   `content` member the installed release encodes, its media type and the
 *   schema of the decoded value, and the document keeps the definitions that
 *   schema names. Versions 2 and 1 print the media type alone, so two
 *   declarations that decode different values share those identities. A
 *   string built with a `reviver` or a `replacer` has no decoded schema in
 *   the representation, so version 3 prints its media type alone too.
 * - `2`, written from `effect@4.0.4` (2026-10-13) until version 3: what the
 *   installed release encodes, with the six check ids renamed after
 *   `4.0.0-rc.115` written back. From `4.0.4` on `Schema.brand` is not part of
 *   the AST, so a brand contributes nothing.
 * - `1`, what every key written under `4.0.0-rc.115` hashed: version 2 with
 *   each brand restored as the `brands` annotation rc.115 wrote, in the place
 *   and key order rc.115 wrote it.
 *
 * @since 1.0.0
 * @private
 */
export const representationIdentityVersions = [3, 2, 1] as const

/**
 * One version of {@link representationIdentityVersions}.
 *
 * @since 1.0.0
 * @private
 */
export type RepresentationIdentityVersion = (typeof representationIdentityVersions)[number]

/** @private */
type Representations = SchemaRepresentation.Document["references"]

/** @private */
type Fields = Record<string, unknown>

/**
 * A schema value `Schema.brand` returned. From `effect@4.0.4` on it shares its
 * base's AST and keeps the brand only as these two own properties, which
 * `annotate`, `check` and the other rebuilding combinators carry forward.
 *
 * @private
 */
interface Branded {
  readonly schema: Schema.Top
  readonly identifier: string
}

/** @private */
const branded = (schema: Schema.Top): Branded | undefined => {
  const fields = schema as unknown as Fields
  return Object.hasOwn(fields, "identifier") && typeof fields["identifier"] === "string" &&
      Object.hasOwn(fields, "schema") && Schema.isSchema(fields["schema"])
    ? { schema: fields["schema"], identifier: fields["identifier"] }
    : undefined
}

/**
 * The schema an `optionalKey` or `mutableKey` field wraps. Such a wrapper
 * changes the AST's context, never its node, so its representation is the
 * wrapped schema's. A tuple or struct with rest also keeps the schema it
 * extends, but adds members of its own, so it is not unwrapped.
 *
 * @private
 */
const contextWrapped = (schema: Schema.Top): Schema.Top | undefined => {
  const inner = (schema as unknown as Fields)["schema"]
  return Schema.isSchema(inner) && inner.ast._tag === schema.ast._tag && !Object.hasOwn(schema, "rest") &&
      !Object.hasOwn(schema, "records")
    ? inner
    : undefined
}

/**
 * The schema below every brand and context wrapper of `schema`, pushing each
 * brand onto `brands` from the outermost in.
 *
 * @private
 */
const peel = (schema: Schema.Top, brands: Array<Branded>): Schema.Top => {
  const brand = branded(schema)
  if (brand !== undefined) {
    brands.push(brand)
    return peel(brand.schema, brands)
  }
  const inner = contextWrapped(schema)
  return inner === undefined ? schema : peel(inner, brands)
}

/**
 * A restored definition as comparable text. Two restorations of one
 * definition share everything but the brands they added, which are strings
 * under string keys, so text that keeps a `bigint` literal and a symbol
 * distinguishes them.
 *
 * @private
 */
const printedRepresentation = (node: Representation): string =>
  JSON.stringify(
    node,
    (_key, value: unknown) =>
      typeof value === "bigint" ? `${value}n` : typeof value === "symbol" ? String(value) : value
  )

/** @private */
const schemas = (value: unknown): ReadonlyArray<Schema.Top> | undefined =>
  Array.isArray(value) && value.every((member) => Schema.isSchema(member)) ? value : undefined

/**
 * Annotations with `identifier` added to `brands` as rc.115's
 * `SchemaAST.brand` added it: appended to a `brands` already present, or
 * placed after the keys the annotations held when the brand was applied
 * (`before`) and ahead of every key annotated since, because rc.115 spread
 * later annotations over the branded ones.
 *
 * @private
 */
const withBrand = (
  current: Readonly<Fields> | undefined,
  before: object | undefined,
  identifier: string
): Fields => {
  const out: Fields = {}
  const entries = Object.entries(current ?? {})
  const brands = current?.["brands"]
  if (Array.isArray(brands)) {
    for (const [key, value] of entries) assignProperty(out, key, key === "brands" ? [...brands, identifier] : value)
    return out
  }
  const earlier = new Set(before === undefined ? [] : Object.keys(before))
  for (const [key, value] of entries) if (earlier.has(key)) assignProperty(out, key, value)
  assignProperty(out, "brands", [identifier])
  for (const [key, value] of entries) if (!earlier.has(key)) assignProperty(out, key, value)
  return out
}

/**
 * A representation node with one brand restored where rc.115 put it: on the
 * last check its base had when the brand was applied, or on the node itself
 * when its base had none. Checks added after the brand keep their own
 * annotations.
 *
 * A brand over a codec, such as `Schema.Trim` or `Schema.NumberFromString`,
 * comes back as it was: rc.115 put that brand on the decoded side, and the
 * representation prints the encoded side, which never showed it.
 *
 * @private
 */
const withNodeBrand = (node: Representation, brand: Branded): Representation => {
  const base = brand.schema.ast
  if (base.encoding !== undefined) return node
  const fields = node as unknown as Fields
  if (base.checks === undefined) {
    return {
      ...fields,
      annotations: withBrand(fields["annotations"] as Fields | undefined, base.annotations, brand.identifier)
    } as unknown as Representation
  }
  const index = base.checks.length - 1
  const checks = [...(fields["checks"] as ReadonlyArray<Fields>)]
  checks[index] = {
    ...checks[index],
    annotations: withBrand(
      checks[index]!["annotations"] as Fields | undefined,
      base.checks[index]!.annotations,
      brand.identifier
    )
  }
  return { ...fields, checks } as unknown as Representation
}

/**
 * A representation document with every brand the schema value carries
 * restored as rc.115 wrote it, at every position the value names its
 * members by: a struct's fields, an array's or a tuple's elements, a union's
 * members, a record's key and value, the field an `optionalKey` or
 * `mutableKey` wraps, and the definition a reference names.
 *
 * A definition every position restores alike is restored once, as rc.115
 * wrote one definition. When two positions restore one definition
 * differently, as when it occurs branded and unbranded or under two brands,
 * rc.115 wrote two definitions and the current encoding writes one, so no
 * single restoration is rc.115's document: the document comes back
 * unrestored, the version 2 bytes. Restoring the first position's brands
 * there would print the document rc.115 wrote for a different declaration,
 * one with that brand at every position, and a key derived from it could
 * replay that declaration's outcome.
 *
 * A brand below a position the value does not name (a class's fields, a
 * suspended or transformed schema, a check's own schema) is not restored
 * either. A declaration either way re-keys once, which is what every branded
 * declaration did before versions.
 *
 * What bounds a restoration that stops short: it only adds `brands`
 * annotations to the version 2 document and changes nothing else, so two
 * declarations can share a version 1 document only if they share a version 2
 * document. A version 1 key can therefore stand for another declaration only
 * when the two differ in brands alone, which version 2, the identity every
 * key since `effect@4.0.4` hashed, does not tell apart either.
 *
 * @private
 */
const withRc115Brands = (
  schema: Schema.Top,
  document: SchemaRepresentation.Document
): SchemaRepresentation.Document => {
  const definitions: Fields = {}
  const references: Fields = {}
  for (const [key, value] of Object.entries(document.references)) {
    assignProperty(definitions, key, value)
    assignProperty(references, key, value)
  }
  // Each definition as the first position that names it restored it.
  const restored = new Map<string, string>()
  let ambiguous = false
  const at = (schema: Schema.Top, node: Representation): Representation => {
    if (node._tag === "Reference") {
      const definition = at(schema, definitions[node.$ref] as Representation)
      const printed = printedRepresentation(definition)
      const first = restored.get(node.$ref)
      if (first === undefined) {
        restored.set(node.$ref, printed)
        assignProperty(references, node.$ref, definition)
      } else if (first !== printed) {
        ambiguous = true
      }
      return node
    }
    const brands: Array<Branded> = []
    const base = peel(schema, brands)
    let out: Representation = node
    for (let index = brands.length - 1; index >= 0; index--) out = withNodeBrand(out, brands[index]!)
    return members(base, out)
  }
  /** The schema a member position names, or the node's own representation where it names none. */
  const member = (schema: unknown, node: Representation): Representation =>
    Schema.isSchema(schema) ? at(schema, node) : node
  const members = (schema: Schema.Top, node: Representation): Representation => {
    const fields = schema as unknown as Fields
    switch (node._tag) {
      case "Objects": {
        // A struct names its fields; a record, or each record a struct with
        // rest adds, names an index signature's key and value.
        const declared = (fields["fields"] ?? (fields["schema"] as Fields | undefined)?.["fields"] ?? {}) as Record<
          PropertyKey,
          unknown
        >
        const records = Schema.isSchema(fields["key"]) ? [schema] : schemas(fields["records"]) ?? []
        return {
          ...node,
          propertySignatures: node.propertySignatures.map((property) => ({
            ...property,
            type: member(Object.hasOwn(declared, property.name) ? declared[property.name] : undefined, property.type)
          })),
          indexSignatures: node.indexSignatures.map((signature, index) => {
            const record = records[index] as unknown as Fields | undefined
            return {
              ...signature,
              parameter: member(record?.["key"], signature.parameter),
              type: member(record?.["value"], signature.type)
            }
          })
        }
      }
      case "Arrays": {
        // A tuple names its elements and, with rest, its rest; an array names
        // the one value every element and the rest share.
        const elements = schemas(fields["elements"]) ??
          schemas((fields["schema"] as Fields | undefined)?.["elements"]) ??
          []
        const rest = schemas(fields["rest"]) ?? []
        const item = fields["value"]
        return {
          ...node,
          elements: node.elements.map((element, index) => ({
            ...element,
            type: member(elements[index] ?? item, element.type)
          })),
          rest: node.rest.map((type, index) => member(rest[index] ?? item, type))
        }
      }
      case "Union": {
        const declared = schemas(fields["members"]) ?? []
        return { ...node, types: node.types.map((type, index) => member(declared[index], type)) }
      }
      default:
        return node
    }
  }
  const representation = at(schema, document.representation)
  return ambiguous ? document : { representation, references: references as Representations }
}

/** Removes the definitions nothing in the projected document names: those only a dropped `content` named. */
const withReachableReferences = (document: Schema.Json): Schema.Json => {
  const projected = document as {
    readonly representation: Schema.Json
    readonly references: Readonly<Record<string, Schema.Json>>
  }
  const reached = new Set<string>()
  const pending: Array<Schema.Json | undefined> = [projected.representation]
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) pending.push(...value)
    else if (isObject(value)) {
      if (value["_tag"] === "Reference" && typeof value["$ref"] === "string") {
        const reference = value["$ref"]
        if (!reached.has(reference)) {
          reached.add(reference)
          pending.push(projected.references[reference])
        }
      } else {
        for (const [key, member] of Object.entries(value)) {
          if (key !== "annotations" && key !== "payload") pending.push(member)
        }
      }
    }
  }
  return {
    representation: projected.representation,
    references: Object.fromEntries(Object.entries(projected.references).filter(([key]) => reached.has(key)))
  }
}

/**
 * The representation identity of a schema: what
 * `SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast))`
 * returned under `effect@4.0.0-rc.115`, key order included, in the given
 * {@link representationIdentityVersions version} (the newest by default). A
 * sealed action's step key hashes it, so it must not move with the installed
 * `effect`.
 *
 * The installed release encodes the representation; this writes back the six
 * check ids renamed after rc.115 and projects the 4.1 pattern metadata to the
 * recorded identity without changing runtime validation. From `effect@4.0.4`
 * on `Schema.brand` is not part of the AST, so versions 3 and 2 omit it, and
 * version 1 restores it from the schema value, where the brand still lives.
 * Version 3 keeps what a JSON string decodes to; versions 2 and 1 print its
 * media type alone, as rc.115 did.
 *
 * Throws what rc.115 threw for a schema with no representation, such as one
 * whose check carries no `representation` annotation.
 *
 * @since 1.0.0
 * @private
 */
export const representationIdentity = (
  schema: Schema.Top,
  version: RepresentationIdentityVersion = representationIdentityVersions[0]
): Schema.Json => {
  const document = SchemaRepresentation.toRepresentation(schema.ast)
  return withReachableReferences(
    withRc115CheckIds(
      SchemaRepresentation.toJson(version === 1 ? withRc115Brands(schema, document) : document),
      version === 3 ? "schema" : "mediaType"
    )
  )
}
