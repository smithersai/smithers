/**
 * The closed JSON Schema subset a manifest may use, its `$ref` resolution,
 * and a validator for it.
 *
 * A schema names only `#/$defs/<Name>` refs from its own manifest, never a URL,
 * so nothing is ever fetched. A field that would collect a secret refuses:
 * secrets stay opaque, and a plugin never asks a person for one. `pattern` is
 * outside the subset: a host would run a plugin's regular expression on
 * arbitrary text, and a backtracking one (`^(a+)+$`) hangs it.
 *
 * @since 1.1.0
 */

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import { type Reason, Refusal } from "./Contribution.ts"
import * as Path from "./internal/path.ts"

/**
 * A JSON value.
 *
 * @category models
 * @since 1.1.0
 */
export type Json = Schema.Json

/**
 * A JSON type name the subset admits.
 *
 * @category models
 * @since 1.1.0
 */
export type TypeName = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null"

/**
 * A schema with every `$ref` inlined: only the admitted keywords remain.
 *
 * @category models
 * @since 1.1.0
 */
export interface Resolved {
  readonly type?: TypeName | ReadonlyArray<TypeName>
  readonly properties?: { readonly [name: string]: Resolved }
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: boolean
  readonly items?: Resolved
  readonly enum?: ReadonlyArray<Json>
  readonly const?: Json
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly oneOf?: ReadonlyArray<Resolved>
  readonly anyOf?: ReadonlyArray<Resolved>
  readonly title?: string
  readonly description?: string
  readonly default?: Json
}

/**
 * The largest schema, in UTF-8 bytes serialized, before and after its refs
 * are inlined.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumBytes = 16_384

/**
 * The deepest a schema nests, counting inlined references.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumDepth = 32

/**
 * The most UTF-8 bytes every schema resolved against one {@link Budget}
 * inlines to together: the size of the largest manifest, so `$ref` reuse
 * never makes a manifest's schemas cost more than the manifest could spell
 * out.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumInlinedBytes = 65_536

/**
 * The inlined bytes several resolutions still share, such as every schema in
 * one manifest. {@link resolve} draws each result's size from it and refuses
 * once it runs out.
 *
 * @category models
 * @since 1.1.0
 */
export interface Budget {
  remaining: number
}

/**
 * A fresh {@link Budget} of {@link maximumInlinedBytes}.
 *
 * @category constructors
 * @since 1.1.0
 */
export const budget = (): Budget => ({ remaining: maximumInlinedBytes })

const typeNames: ReadonlySet<string> = new Set(["object", "array", "string", "integer", "number", "boolean", "null"])
const keywords: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "oneOf",
  "anyOf",
  "title",
  "description",
  "default",
  "$ref"
])
const counts: ReadonlySet<string> = new Set(["minLength", "maxLength", "minItems", "maxItems"])
const secretName = /secret|password|token|credential/i
const reference = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_-]{0,63})$/

const isObject = (value: unknown): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const bytes = (value: Json): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** The walk's failure, before it becomes a Refusal. */
class Stop {
  readonly reason: Reason
  readonly path: string
  readonly detail: string
  constructor(reason: Reason, path: string, detail: string) {
    this.reason = reason
    this.path = path
    this.detail = detail
  }
}

interface Walk {
  readonly defs: { readonly [name: string]: Json }
  readonly stack: Array<string>
  nodes: number
  depth: number
}

const node = (walk: Walk, schema: Json, path: string): Resolved => {
  if (!isObject(schema)) throw new Stop("invalid", path, "a schema is a JSON object")
  if (++walk.nodes > maximumBytes / 2) {
    throw new Stop("invalid", path, `the schema exceeds ${maximumBytes} bytes once its references are inlined`)
  }
  if (schema["format"] === "password" || schema["writeOnly"] === true) {
    throw new Stop("secret_field", path, "a plugin schema never collects a secret")
  }
  for (const [index, key] of Object.keys(schema).entries()) {
    if (!keywords.has(key)) {
      throw new Stop("schema_unresolved", Path.append(path, key, index), "the keyword is outside the closed subset")
    }
  }
  if (walk.depth >= maximumDepth) throw new Stop("invalid", path, `a schema nests at most ${maximumDepth} deep`)
  walk.depth++
  const ref = schema["$ref"]
  const resolved = ref === undefined
    ? Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [key, keyword(walk, key, value, Path.append(path, key))])
    ) as Resolved
    : inline(walk, schema, ref, path)
  walk.depth--
  return resolved
}

const inline = (walk: Walk, schema: { readonly [key: string]: Json }, ref: Json, path: string): Resolved => {
  const at = Path.append(path, "$ref")
  const match = typeof ref === "string" ? reference.exec(ref) : null
  if (match === null) throw new Stop("schema_unresolved", at, "a $ref names only this manifest's #/$defs/<Name>")
  if (Object.keys(schema).some((key) => key !== "$ref" && key !== "title" && key !== "description")) {
    throw new Stop("schema_unresolved", at, "a $ref stands alone, beside only title and description")
  }
  const name = match[1]!
  if (!Object.hasOwn(walk.defs, name)) throw new Stop("schema_unresolved", at, `no $defs entry ${name}`)
  if (walk.stack.includes(name)) throw new Stop("schema_unresolved", at, `the $defs entry ${name} refers to itself`)
  walk.stack.push(name)
  const resolved = node(walk, walk.defs[name]!, Path.append("$defs", name))
  walk.stack.pop()
  return resolved
}

const schemas = (walk: Walk, value: Json, path: string): ReadonlyArray<Resolved> => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Stop("invalid", path, "expected a non-empty array of schemas")
  }
  return value.map((member, index) => node(walk, member, Path.append(path, index)))
}

const keyword = (walk: Walk, key: string, value: Json, path: string): unknown => {
  switch (key) {
    case "type": {
      const names = Array.isArray(value) ? value : [value]
      if (names.length === 0 || !names.every((name) => typeof name === "string" && typeNames.has(name))) {
        throw new Stop("invalid", path, "expected a JSON type name or a non-empty array of them")
      }
      return value
    }
    case "properties": {
      if (!isObject(value)) throw new Stop("invalid", path, "expected an object of schemas")
      return Object.fromEntries(
        Object.entries(value).map(([name, member], index) => {
          const at = Path.append(path, name, index)
          if (secretName.test(name)) throw new Stop("secret_field", at, "a plugin schema never collects a secret")
          return [name, node(walk, member, at)]
        })
      )
    }
    case "required":
      if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
        throw new Stop("invalid", path, "expected an array of property names")
      }
      return value
    case "additionalProperties":
      if (typeof value !== "boolean") throw new Stop("schema_unresolved", path, "additionalProperties is a boolean")
      return value
    case "items":
      if (Array.isArray(value)) throw new Stop("schema_unresolved", path, "items is one schema, never a tuple")
      return node(walk, value, path)
    case "enum":
      if (!Array.isArray(value) || value.length === 0) throw new Stop("invalid", path, "expected a non-empty array")
      return value
    case "minimum":
    case "maximum":
      if (typeof value !== "number") throw new Stop("invalid", path, "expected a number")
      return value
    case "oneOf":
    case "anyOf":
      return schemas(walk, value, path)
    case "title":
    case "description":
      if (typeof value !== "string") throw new Stop("invalid", path, "expected a string")
      return value
    default:
      if (counts.has(key) && !(Number.isInteger(value) && (value as number) >= 0)) {
        throw new Stop("invalid", path, "expected a non-negative integer")
      }
      // `const`, `default` and the counts carry any JSON value as is.
      return value
  }
}

/**
 * Admits a schema in the closed subset and inlines every `$ref` from `defs`.
 *
 * Refuses `schema_unresolved` for a keyword outside the subset, a URL or
 * unknown ref, or a ref cycle; `secret_field` for a `password` format,
 * `writeOnly: true`, or a property named like a secret; `invalid` for a
 * malformed keyword or a schema over {@link maximumBytes}, or one that
 * overdraws `shared`. `at` prefixes every path the refusal names; refs inside
 * `defs` are named `$defs.<Name>`. Without `shared` the call has its own
 * {@link budget}.
 *
 * @category resolution
 * @since 1.1.0
 */
export const resolve = (
  schema: Json,
  defs: { readonly [name: string]: Json } = {},
  at = "",
  shared: Budget = budget()
): Effect.Effect<Resolved, Refusal> =>
  Effect.suspend(() => {
    if (bytes(schema) > maximumBytes) {
      return Effect.fail(
        new Refusal({ reason: "invalid", path: at, detail: `the schema exceeds ${maximumBytes} bytes` })
      )
    }
    try {
      const resolved = node({ defs, stack: [], nodes: 0, depth: 0 }, schema, at)
      const size = bytes(resolved as Json)
      if (size > maximumBytes) {
        return Effect.fail(
          new Refusal({
            reason: "invalid",
            path: at,
            detail: `the schema exceeds ${maximumBytes} bytes once its references are inlined`
          })
        )
      }
      shared.remaining -= size
      return shared.remaining < 0
        ? Effect.fail(
          new Refusal({
            reason: "invalid",
            path: at,
            detail: `the schemas exceed ${maximumInlinedBytes} bytes together once their references are inlined`
          })
        )
        : Effect.succeed(resolved)
    } catch (stop) {
      const { detail, path, reason } = stop as Stop
      return Effect.fail(new Refusal({ reason, path, detail }))
    }
  })

/**
 * Every property name a resolved schema declares, its `oneOf` and `anyOf`
 * members' included, first declaration first.
 *
 * @category accessors
 * @since 1.1.0
 */
export const properties = (resolved: Resolved): ReadonlyArray<string> => {
  const names = new Set(Object.keys(resolved.properties ?? {}))
  for (const member of [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])]) {
    for (const name of properties(member)) names.add(name)
  }
  return [...names]
}

const equal = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]))
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  }
  return false
}

const hasType = (name: TypeName, value: unknown): boolean => {
  switch (name) {
    case "object":
      return isObject(value)
    case "array":
      return Array.isArray(value)
    case "integer":
      return Number.isInteger(value)
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "null":
      return value === null
    default:
      return typeof value === name
  }
}

const check = (schema: Resolved, value: unknown, path: string): string | undefined => {
  if (schema.type !== undefined) {
    const names: ReadonlyArray<TypeName> = typeof schema.type === "string" ? [schema.type] : schema.type
    if (!names.some((name) => hasType(name, value))) return path
  }
  if (schema.const !== undefined && !equal(schema.const, value)) return path
  if (schema.enum !== undefined && !schema.enum.some((member) => equal(member, value))) return path
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return path
    if (schema.maximum !== undefined && value > schema.maximum) return path
  }
  if (typeof value === "string") {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) return path
    if (schema.maxLength !== undefined && length > schema.maxLength) return path
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return path
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return path
    if (schema.items !== undefined) {
      for (const [index, member] of value.entries()) {
        const failure = check(schema.items, member, `${path}[${index}]`)
        if (failure !== undefined) return failure
      }
    }
  }
  if (isObject(value)) {
    for (const [index, name] of (schema.required ?? []).entries()) {
      if (!Object.hasOwn(value, name)) return Path.append(path, name, index)
    }
    const declared = schema.properties ?? {}
    for (const [index, [name, member]] of Object.entries(value).entries()) {
      const at = Path.append(path, name, index)
      if (Object.hasOwn(declared, name)) {
        const failure = check(declared[name]!, member, at)
        if (failure !== undefined) return failure
      } else if (schema.additionalProperties === false) return at
    }
  }
  if (schema.anyOf !== undefined && !schema.anyOf.some((member) => check(member, value, path) === undefined)) {
    return path
  }
  if (
    schema.oneOf !== undefined && schema.oneOf.filter((member) => check(member, value, path) === undefined).length !== 1
  ) return path
  return undefined
}

/**
 * Validates a value against a resolved schema: the path of the first value
 * that fails (`$.note`, `$.options[2]`), or none when it conforms.
 *
 * @category validation
 * @since 1.1.0
 */
export const validate = (resolved: Resolved, value: unknown): Option.Option<string> =>
  Option.fromUndefinedOr(check(resolved, value, "$"))

/**
 * The schema of a named property: from `properties`, else from the first
 * `oneOf` or `anyOf` member that declares it.
 *
 * @category accessors
 * @since 1.1.0
 */
export const property = (resolved: Resolved, name: string): Resolved | undefined => {
  if (resolved.properties !== undefined && Object.hasOwn(resolved.properties, name)) return resolved.properties[name]
  for (const member of [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])]) {
    const found = property(member, name)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The schema a path reaches: a name steps into a property, a number into
 * `items`. Undefined when the schema does not declare the step.
 *
 * @category accessors
 * @since 1.1.0
 */
export const at = (resolved: Resolved, path: ReadonlyArray<string | number>): Resolved | undefined => {
  let current: Resolved | undefined = resolved
  for (const segment of path) {
    current = typeof segment === "number" ? current.items : property(current, segment)
    if (current === undefined) return undefined
  }
  return current
}
