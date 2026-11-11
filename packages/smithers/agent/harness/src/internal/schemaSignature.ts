/**
 * A flow's input schema as the type a model writes a call against.
 *
 * The catalog names every callable flow and what it takes, on every frame. It
 * printed each input as its JSON Schema document, which states one optional
 * string as `{"anyOf":[{"type":"string","description":"…"},{"type":"null"}]}`
 * and a two-variant input as two whole objects. On the native host's
 * thirteen-flow catalog that was 17,521 characters of a 27,595-character
 * system prompt, 3,955 of them `bash` alone.
 *
 * {@link render} prints the same schema as a TypeScript-shaped type: one line
 * per property, `?` for a property a call may omit, the description as a
 * trailing comment. It is a rendering, not a summary: every keyword it reads
 * reaches the text (a bound as a note beside the description), and a schema
 * that uses a keyword it does not read is not rendered at all, so the caller
 * prints the document instead. Nothing a cell needs to choose an input is
 * dropped to save characters.
 *
 * @since 1.0.0-rc.17
 */

/**
 * One rendered schema node: its type text, the notes its own keywords add, and
 * the description it carries.
 */
interface Node {
  readonly text: string
  readonly notes: ReadonlyArray<string>
  readonly said: string | undefined
}

/** A node's notes followed by its description, when the notes do not already say it. */
const remarks = (node: Node): ReadonlyArray<string> =>
  node.said === undefined || node.notes.includes(node.said) ? node.notes : [...node.notes, node.said]

type Json = unknown

const isRecord = (value: Json): value is Readonly<Record<string, Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Keywords that only document a node; they never change what it accepts. */
const annotations = new Set(["description", "title"])

/** Keywords that bound a value, rendered as notes beside its description. */
const bounds: ReadonlyArray<readonly [keyword: string, label: string]> = [
  ["minimum", "min"],
  ["maximum", "max"],
  ["exclusiveMinimum", ">"],
  ["exclusiveMaximum", "<"],
  ["multipleOf", "multiple of"],
  ["minLength", "min length"],
  ["maxLength", "max length"],
  ["pattern", "pattern"],
  ["format", "format"],
  ["minItems", "min items"],
  ["maxItems", "max items"],
  ["default", "default"]
]

const boundKeywords = new Set(bounds.map(([keyword]) => keyword))

const structural = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "enum",
  "const",
  "$ref"
])

/** The document's named schemas, and the references being expanded right now. */
interface Scope {
  readonly definitions: Readonly<Record<string, Json>>
  readonly expanding: ReadonlyArray<string>
}

/** The definition a `#/$defs/<name>` reference names, with its JSON Pointer escapes undone. */
const referenced = (reference: Json): string | undefined =>
  typeof reference === "string" && reference.startsWith("#/$defs/")
    ? reference.slice("#/$defs/".length).replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined

const literal = (value: Json): string => JSON.stringify(value)

const notesOf = (schema: Readonly<Record<string, Json>>): ReadonlyArray<string> =>
  bounds.flatMap(([keyword, label]) =>
    schema[keyword] === undefined
      ? []
      // A pattern or a format reads as itself; a default is the value a call would write.
      : [
        `${label} ${
          typeof schema[keyword] === "string" && keyword !== "default" ? schema[keyword] : literal(schema[keyword])
        }`
      ]
  )

/** The description a node carries, on one line. */
const describe = (schema: Readonly<Record<string, Json>>): string | undefined => {
  const parts = [schema.title, schema.description].filter((part): part is string =>
    typeof part === "string" && part !== ""
  )
  return parts.length === 0 ? undefined : parts.join(": ").replace(/\s*\n\s*/g, " ")
}

/** How JSON Schema spells the non-finite numbers Effect's `Number` admits. */
const nonFinite = (schema: Json): boolean =>
  isRecord(schema) && schema.type === "string" && Array.isArray(schema.enum) &&
  schema.enum.every((member) => member === "Infinity" || member === "-Infinity" || member === "NaN")

const isNull = (schema: Json): boolean => isRecord(schema) && schema.type === "null" && Object.keys(schema).length === 1

const pad = (depth: number): string => "  ".repeat(depth)

/** Whether a type's text is a union at its own level, outside every bracket it opens. */
const isUnion = (text: string): boolean => {
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if ("({[<".includes(character)) depth++
    else if (")}]>".includes(character)) depth--
    else if (depth === 0 && text.startsWith(" | ", index)) return true
  }
  return false
}

/** The item type of an array, parenthesized when it is a union: `(A | B)[]`. */
const grouped = (text: string): string => isUnion(text) ? `(${text})` : text

const union = (members: ReadonlyArray<Json>, depth: number, scope: Scope): Node | undefined => {
  // `number | "Infinity" | "-Infinity" | "NaN"` is how a schema says `number`.
  const numeric = members.some((member) => isRecord(member) && member.type === "number")
  const kept = members.filter((member) => !isNull(member) && !(numeric && nonFinite(member)))
  const nullable = members.some(isNull)
  const rendered: Array<Node> = []
  for (const member of kept) {
    const node = type(member, depth, scope)
    if (node === undefined) return undefined
    // A member's own description belongs to the property the union describes.
    rendered.push({ text: node.text, notes: remarks(node), said: undefined })
  }
  if (rendered.length === 0) return nullable ? { text: "null", notes: [], said: undefined } : undefined
  const text = rendered.map((node) => node.text).join(" | ")
  return {
    text: nullable ? `${text} | null` : text,
    notes: rendered.flatMap((node) => node.notes),
    said: undefined
  }
}

const object = (schema: Readonly<Record<string, Json>>, depth: number, scope: Scope): Node | undefined => {
  const properties = schema.properties === undefined ? {} : schema.properties
  if (!isRecord(properties)) return undefined
  const required = schema.required === undefined ? [] : schema.required
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !(name in properties))) {
    return undefined
  }
  const names = Object.keys(properties)
  const extra = schema.additionalProperties
  let rest: Node | undefined
  if (extra === undefined || extra === true) rest = { text: "unknown", notes: [], said: undefined }
  else if (extra !== false) {
    rest = type(extra, depth + 1, scope)
    if (rest === undefined) return undefined
  }
  if (names.length === 0) {
    return rest === undefined
      ? { text: "{}", notes: [], said: undefined }
      : { text: `Record<string, ${rest.text}>`, notes: remarks(rest), said: undefined }
  }
  const lines: Array<string> = []
  for (const name of names) {
    const member = properties[name]
    const node = type(member, depth + 1, scope)
    if (node === undefined) return undefined
    // A property a call may leave out: not required, or allowed to be null.
    const nullable = node.text.endsWith(" | null")
    const optional = !required.includes(name) || nullable
    const text = nullable && node.text !== "null" ? node.text.slice(0, -" | null".length) : node.text
    const comment = remarks(node)
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : literal(name)
    lines.push(
      `${pad(depth + 1)}${key}${optional ? "?" : ""}: ${text}${comment.length === 0 ? "" : ` // ${comment.join("; ")}`}`
    )
  }
  if (rest !== undefined && extra !== undefined && extra !== true) {
    const comment = remarks(rest)
    lines.push(`${pad(depth + 1)}[key: string]: ${rest.text}${comment.length === 0 ? "" : ` // ${comment.join("; ")}`}`)
  }
  return { text: `{\n${lines.join("\n")}\n${pad(depth)}}`, notes: [], said: undefined }
}

const type = (schema: Json, depth: number, scope: Scope): Node | undefined => {
  if (!isRecord(schema)) return undefined
  for (const keyword of Object.keys(schema)) {
    if (!annotations.has(keyword) && !boundKeywords.has(keyword) && !structural.has(keyword)) return undefined
  }
  const notes = notesOf(schema)
  const said = describe(schema)
  if (schema.$ref !== undefined) {
    // A reference is expanded where it stands; one that reaches itself is not a finite type.
    const name = referenced(schema.$ref)
    if (name === undefined || !(name in scope.definitions) || scope.expanding.includes(name)) return undefined
    if (Object.keys(schema).some((keyword) => keyword !== "$ref" && !annotations.has(keyword))) return undefined
    const named = type(scope.definitions[name], depth, { ...scope, expanding: [...scope.expanding, name] })
    // What the reference says of itself comes before what its definition says.
    return named === undefined ? undefined : { ...named, said: said ?? named.said }
  }
  if (schema.const !== undefined) return { text: literal(schema.const), notes, said }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) return undefined
    return { text: schema.enum.map(literal).join(" | "), notes, said }
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.type !== undefined) return undefined
    const node = union(schema.anyOf, depth, scope)
    return node === undefined ? undefined : { text: node.text, notes: [...notes, ...node.notes], said }
  }
  switch (schema.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return { text: schema.type, notes, said }
    case "array": {
      if (schema.items === undefined) return { text: "unknown[]", notes, said }
      const item = type(schema.items, depth, scope)
      if (item === undefined) return undefined
      return {
        text: `${grouped(item.text)}[]`,
        notes: [
          ...notes,
          ...item.notes.map((note) => `each ${note}`),
          ...(item.said === undefined ? [] : [`each: ${item.said}`])
        ],
        said
      }
    }
    case "object": {
      const node = object(schema, depth, scope)
      return node === undefined ? undefined : { text: node.text, notes: [...notes, ...node.notes], said }
    }
    case undefined:
      // A node that constrains nothing accepts any JSON value.
      return { text: "unknown", notes, said }
    default:
      return undefined
  }
}

/**
 * Renders a flow's input schema document as a compact type, or `undefined`
 * when the document is not one this module reads whole.
 *
 * `document` is what a flow projection carries: `{ dialect, schema,
 * definitions }`, where `definitions` holds the schemas a `$ref` names. A
 * reference that names nothing or reaches itself, a keyword outside the ones
 * listed above, or any other shape answers `undefined`, and the caller prints
 * the document as it stands. `depth` is how far the caller has already
 * indented the line the type starts on.
 *
 * @since 1.0.0-rc.17
 * @private
 */
export const render = (document: Json, depth = 0): string | undefined => {
  if (!isRecord(document) || document.schema === undefined) return undefined
  for (const keyword of Object.keys(document)) {
    if (keyword !== "dialect" && keyword !== "schema" && keyword !== "definitions") return undefined
  }
  const definitions = document.definitions === undefined ? {} : document.definitions
  if (!isRecord(definitions)) return undefined
  const node = type(document.schema, depth, { definitions, expanding: [] })
  if (node === undefined) return undefined
  const comment = remarks(node)
  return comment.length === 0 ? node.text : `${node.text} // ${comment.join("; ")}`
}
