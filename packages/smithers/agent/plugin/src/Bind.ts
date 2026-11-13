/**
 * The closed binding grammar a view event's `args` and a keybinding's
 * `fields` are written in, and the host's filling of them.
 *
 * A value is a JSON literal, or a string reference rooted at `$item` (the
 * selected row of the view's `reads`), `$event` (the event's payload) or
 * `$key` (the key pressed: `$key.index` is 0 for `1` … 8 for `9`), followed by
 * at most four `.<name>`, `[<n>]` or `[$event.<name>]` segments, as in
 * `$item.options[$event.index]`. A string not starting with `$` is a literal;
 * objects and arrays are walked. Nothing else is evaluated.
 *
 * @since 1.1.0
 */

import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import { Refusal } from "./Contribution.ts"
import * as Path from "./internal/path.ts"

/**
 * Where a reference starts.
 *
 * @category models
 * @since 1.1.0
 */
export type Root = "item" | "event" | "key"

/**
 * One step of a reference: a field name, an array index, or an index read
 * from the event's payload.
 *
 * @category models
 * @since 1.1.0
 */
export type Segment = string | number | { readonly event: string }

/**
 * A parsed reference, and where in the args it was written.
 *
 * @category models
 * @since 1.1.0
 */
export interface Reference {
  readonly root: Root
  readonly path: ReadonlyArray<Segment>
  /** The arg it was written at, as `value.note`. */
  readonly at: string
}

/**
 * The values a binding is filled from.
 *
 * @category models
 * @since 1.1.0
 */
export interface Scope {
  readonly item: unknown
  readonly event: unknown
  readonly key?: { readonly index: number } | undefined
}

/**
 * The most segments after a reference's root.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumSegments = 4

const rootPattern = /^\$(item|event|key)/
const segmentPattern = /^(?:\.([A-Za-z_][A-Za-z0-9_-]{0,63})|\[(\d{1,6})\]|\[\$event\.([A-Za-z_][A-Za-z0-9_-]{0,63})\])/

const parseReference = (text: string): { readonly root: Root; readonly path: ReadonlyArray<Segment> } | undefined => {
  const root = rootPattern.exec(text)
  if (root === null) return undefined
  const path: Array<Segment> = []
  let rest = text.slice(root[0].length)
  while (rest !== "") {
    const segment = segmentPattern.exec(rest)
    if (segment === null || path.length === maximumSegments) return undefined
    path.push(
      segment[1] !== undefined ? segment[1] : segment[2] !== undefined ? Number(segment[2]) : { event: segment[3]! }
    )
    rest = rest.slice(segment[0].length)
  }
  return { root: root[1] as Root, path }
}

const walk = (
  value: Schema.Json,
  at: string,
  visit: (text: string, at: string) => void
): void => {
  if (typeof value === "string") {
    if (value.startsWith("$")) visit(value, at)
  } else if (Array.isArray(value)) {
    value.forEach((member, index) => walk(member, Path.append(at, index), visit))
  } else if (typeof value === "object" && value !== null) {
    for (const [index, [key, member]] of Object.entries(value).entries()) {
      walk(member, Path.append(at, key, index), visit)
    }
  }
}

/**
 * Every reference a binding makes, in the order written. A string starting
 * with `$` outside the grammar refuses `invalid`, its path `at` followed by
 * the arg it was written at.
 *
 * @category parsing
 * @since 1.1.0
 */
export const references = (
  args: { readonly [key: string]: Schema.Json },
  at = ""
): Result.Result<ReadonlyArray<Reference>, Refusal> => {
  const found: Array<Reference> = []
  let refused: Refusal | undefined
  for (const [index, [key, value]] of Object.entries(args).entries()) {
    walk(value, Path.append("", key, index), (text, written) => {
      const parsed = parseReference(text)
      if (parsed !== undefined) found.push({ ...parsed, at: written })
      else {
        refused ??= new Refusal({
          reason: "invalid",
          path: Path.prefix(at, written),
          detail: "the reference is outside the binding grammar"
        })
      }
    })
  }
  return refused === undefined ? Result.succeed(found) : Result.fail(refused)
}

const text = (root: Root, path: ReadonlyArray<Segment>): string =>
  path.reduce<string>(
    (out, segment) =>
      typeof segment === "string"
        ? `${out}.${segment}`
        : typeof segment === "number"
        ? `${out}[${segment}]`
        : `${out}[$event.${segment.event}]`,
    `$${root}`
  )

const own = (value: unknown, key: string | number): { readonly found: boolean; readonly value?: unknown } => {
  if (typeof key === "number") {
    return Array.isArray(value) && key < value.length ? { found: true, value: value[key] } : { found: false }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
    ? { found: true, value: (value as Record<string, unknown>)[key] }
    : { found: false }
}

const lookup = (reference: string, scope: Scope): Result.Result<unknown, string> => {
  const parsed = parseReference(reference)
  if (parsed === undefined) return Result.fail(`${reference.slice(0, 64)} is outside the binding grammar`)
  const missing = Result.fail(`${text(parsed.root, parsed.path)} is missing`)
  let current: unknown = parsed.root === "item" ? scope.item : parsed.root === "event" ? scope.event : scope.key
  for (const segment of parsed.path) {
    let key: string | number
    if (typeof segment === "object") {
      const index = own(scope.event, segment.event)
      if (!index.found || !Number.isInteger(index.value) || (index.value as number) < 0) return missing
      key = index.value as number
    } else key = segment
    const next = own(current, key)
    if (!next.found) return missing
    current = next.value
  }
  return current === undefined ? missing : Result.succeed(current)
}

const fill = (value: Schema.Json, scope: Scope): Result.Result<unknown, string> => {
  if (typeof value === "string") return value.startsWith("$") ? lookup(value, scope) : Result.succeed(value)
  if (Array.isArray(value)) {
    const out: Array<unknown> = []
    for (const member of value) {
      const filled = fill(member, scope)
      if (Result.isFailure(filled)) return filled
      out.push(filled.success)
    }
    return Result.succeed(out)
  }
  if (typeof value === "object" && value !== null) {
    const out: Array<readonly [string, unknown]> = []
    for (const [key, member] of Object.entries(value)) {
      const filled = fill(member, scope)
      if (Result.isFailure(filled)) return filled
      out.push([key, filled.success])
    }
    return Result.succeed(Object.fromEntries(out))
  }
  return Result.succeed(value)
}

/**
 * Fills a binding from a scope: literals as written, references by value. A
 * reference that reaches no value fails, naming the reference.
 *
 * @category binding
 * @since 1.1.0
 */
export const bind = (
  args: { readonly [key: string]: Schema.Json },
  scope: Scope
): Result.Result<{ readonly [key: string]: unknown }, string> =>
  fill(args, scope) as Result.Result<{ readonly [key: string]: unknown }, string>
