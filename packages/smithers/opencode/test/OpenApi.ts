/**
 * The 1.18.31 OpenAPI document as a schema oracle.
 *
 * `test/fixtures/opencode-1.18.31.schemas.json` is the `components.schemas`
 * closure of the shapes this server answers, lifted verbatim out of the
 * document OpenCode 1.18.31 serves at `/doc`. A route that answers a shape
 * the document declares is asserted against the declaration rather than
 * against a hand-written literal, so a field OpenCode requires and we drop
 * fails here instead of in the app.
 *
 * The checker covers the JSON Schema subset the document uses: `$ref`,
 * `type`, `properties`, `required`, `items`, `anyOf`, `allOf`, `oneOf`,
 * `enum`, `const`, and `nullable`. Extra properties pass: OpenCode's own
 * session rows carry fields the document omits.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const document = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "opencode-1.18.31.schemas.json"), "utf8")
) as { readonly source: string; readonly schemas: Record<string, Schema> }

interface Schema {
  readonly $ref?: string
  readonly type?: string | ReadonlyArray<string>
  readonly properties?: Record<string, Schema>
  readonly required?: ReadonlyArray<string>
  readonly items?: Schema
  readonly anyOf?: ReadonlyArray<Schema>
  readonly oneOf?: ReadonlyArray<Schema>
  readonly allOf?: ReadonlyArray<Schema>
  readonly enum?: ReadonlyArray<unknown>
  readonly const?: unknown
  readonly nullable?: boolean
}

/** The OpenCode release the oracle was lifted from. */
export const source: string = document.source

/** The names the oracle declares, for a test that asserts it is complete. */
export const declared: ReadonlyArray<string> = Object.keys(document.schemas)

const resolve = (schema: Schema): Schema =>
  schema.$ref === undefined ? schema : resolve(document.schemas[schema.$ref.replace("#/components/schemas/", "")]!)

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number"
    ? (Number.isInteger(value) ? "integer" : "number")
    : typeof value

const matches = (declaredType: string, value: unknown): boolean => {
  const actual = typeOf(value)
  return declaredType === actual || (declaredType === "number" && actual === "integer")
}

const check = (schema: Schema, value: unknown, path: string, issues: Array<string>): void => {
  const it = resolve(schema)
  if (it.const !== undefined && value !== it.const) {
    issues.push(`${path}: expected ${JSON.stringify(it.const)}, got ${JSON.stringify(value)}`)
    return
  }
  if (it.enum !== undefined && !it.enum.includes(value)) {
    issues.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(it.enum)}`)
    return
  }
  const branches = it.anyOf ?? it.oneOf
  if (branches !== undefined) {
    if (branches.some((branch) => violations(branch, value, path).length === 0)) return
    issues.push(`${path}: matched none of ${branches.length} declared shapes`)
    return
  }
  if (it.allOf !== undefined) {
    for (const [index, branch] of it.allOf.entries()) check(branch, value, `${path}/allOf[${index}]`, issues)
    return
  }
  if (it.type !== undefined) {
    const allowed = Array.isArray(it.type) ? it.type : [it.type]
    const permitted = it.nullable === true ? [...allowed, "null"] : allowed
    if (!permitted.some((declaredType) => matches(declaredType, value))) {
      issues.push(`${path}: expected ${permitted.join(" | ")}, got ${typeOf(value)}`)
      return
    }
  }
  if (it.items !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) check(it.items, item, `${path}[${index}]`, issues)
  }
  if (it.properties === undefined || typeOf(value) !== "object") return
  const record = value as Record<string, unknown>
  for (const name of it.required ?? []) {
    if (!(name in record)) issues.push(`${path}/${name}: required by the OpenAPI, absent`)
  }
  for (const [name, property] of Object.entries(it.properties)) {
    if (name in record && record[name] !== undefined) check(property, record[name], `${path}/${name}`, issues)
  }
}

/**
 * Every way `value` departs from the declared schema, empty when it
 * conforms. `name` is a schema name in the oracle or an inline schema.
 */
export const violations = (name: string | Schema, value: unknown, path = ""): ReadonlyArray<string> => {
  const schema = typeof name === "string" ? document.schemas[name] : name
  if (schema === undefined) return [`${path}: the oracle declares no schema named ${String(name)}`]
  const issues: Array<string> = []
  check(schema, value, path === "" ? (typeof name === "string" ? name : "value") : path, issues)
  return issues
}
