/**
 * Renders an arbitrary failure value as one bounded, redacted diagnostic
 * string. The engine writes it to the log line that names an undeclared
 * failure, and the flow proxy logs it in place of the defect it dies with, so
 * a secret an implementation error carries never reaches a log file or a
 * remote caller verbatim.
 *
 * @since 1.0.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

/**
 * A body failure rendered for one log line, bounded so an oversized payload
 * cannot flood the log the operator is reading it from.
 *
 * @private
 */
const diagnosticTextLimit = 512

/**
 * How much of one string is read before it is redacted.
 *
 * Redaction runs on the value before the {@link diagnosticTextLimit} bound, so
 * a quoted credential or a private key the bound would cut in half is seen
 * whole. This window only caps the regex work on a hostile multi-megabyte
 * message: everything past it is dropped, never rendered.
 *
 * @private
 */
const redactionWindow = 64 * 1024

/**
 * What a host can say about a value without running the value's own code.
 *
 * `isProxy` must answer from an internal slot, as `util.types.isProxy` does
 * on Node and Bun. No portable operation can: reading even a descriptor off a
 * proxy runs its trap, which is caller code.
 *
 * @private
 * @since 1.0.0
 */
export interface Reflection {
  readonly isProxy: (value: object) => boolean
}

/**
 * The part of a host {@link hostReflection} reads: `process.getBuiltinModule`,
 * typed structurally so this module carries no Node binding.
 *
 * @private
 * @since 1.0.0
 */
export interface BuiltinSource {
  readonly getBuiltinModule?: ((id: string) => unknown) | undefined
}

/**
 * The reflection one host offers, or `undefined` when it offers none.
 *
 * A host with no accessor, one that rejects the id, and one whose module
 * lacks the predicate all answer `undefined`: the renderer then inspects no
 * object at all, so a compatibility shim can neither fail the engine's import
 * nor expose a diagnostic to a proxy trap.
 *
 * @private
 * @since 1.0.0
 */
export const hostReflection = (source: BuiltinSource | undefined): Reflection | undefined => {
  try {
    const util = source?.getBuiltinModule?.("node:util") as
      | { readonly types?: { readonly isProxy?: unknown } }
      | undefined
    const isProxy = util?.types?.isProxy
    return typeof isProxy === "function" ? { isProxy: isProxy as Reflection["isProxy"] } : undefined
  } catch {
    return undefined
  }
}

/**
 * The reflection diagnostics are rendered with.
 *
 * The default is what this process offers, read on first use rather than when
 * the module loads. A host layer provides its own, and providing `undefined`
 * makes every object opaque.
 *
 * @private
 * @since 1.0.0
 */
export const CurrentReflection = Context.Reference<Reflection | undefined>(
  "@smthrs/engine/internal/Diagnostic/CurrentReflection",
  { defaultValue: () => hostReflection((globalThis as { readonly process?: BuiltinSource }).process) }
)

/** What an object renders as when the host cannot inspect it safely. */
const uninspected = "[uninspected]"

const primitiveDiagnostic = (value: unknown): unknown => {
  switch (typeof value) {
    case "string":
      return value.slice(0, redactionWindow)
    case "number":
      return Number.isFinite(value)
        ? value
        : Number.isNaN(value)
        ? "[NaN]"
        : `[${value > 0 ? "+" : "-"}non-finite number]`
    case "boolean":
      return value
    case "undefined":
      return "[undefined]"
    case "bigint":
      return `[bigint:${value.toString().slice(0, 64)}]`
    case "symbol":
      return "[symbol]"
    case "function":
      return "[function]"
    case "object":
      return value === null ? null : undefined
  }
}

const diagnosticKeys = [
  "_tag",
  "code",
  "name",
  "message",
  "value",
  "error",
  "cause",
  "failures",
  "reasons",
  "token",
  "secret",
  "password",
  "apiKey",
  "~effect/Effect/args"
] as const

const projectDiagnostic = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  reflection: Reflection | undefined,
  field?: string
): unknown => {
  if (field !== undefined && Redaction.isSensitiveKey(field)) return Redaction.placeholder
  const primitive = primitiveDiagnostic(value)
  if (primitive !== undefined || value === undefined) {
    return primitive
  }
  if (depth === 0) return "[object]"
  const object = value as object
  // Without a slot-based proxy test every reflective read may run caller code,
  // so nothing is read: the object stays opaque.
  if (reflection === undefined) return uninspected
  if (reflection.isProxy(object)) return "[proxy]"
  if (seen.has(object)) return "[circular]"
  seen.add(object)
  if (Array.isArray(object)) {
    // Every Array exotic has one non-configurable numeric length data property;
    // reading its descriptor does not invoke a Proxy `get` trap or user code.
    const length = Object.getOwnPropertyDescriptor(object, "length")!.value as number
    const output: Array<unknown> = []
    const limit = Math.min(length, 8)
    for (let index = 0; index < limit; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
      output.push(
        descriptor !== undefined && "value" in descriptor
          ? projectDiagnostic(descriptor.value, depth - 1, seen, reflection)
          : "[missing]"
      )
    }
    if (length > limit) output.push(`[${length - limit} more]`)
    return output
  }
  const output: Record<string, unknown> = {}
  for (const key of diagnosticKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor === undefined || !("value" in descriptor)) continue
    output[key] = projectDiagnostic(descriptor.value, depth - 1, seen, reflection, key)
  }
  return Object.keys(output).length === 0 ? "[object]" : output
}

/** Bounds every string of an already redacted projection. */
const boundDiagnostic = (value: unknown): unknown =>
  typeof value === "string"
    ? value.slice(0, diagnosticTextLimit)
    : Array.isArray(value)
    ? value.map(boundDiagnostic)
    : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, boundDiagnostic(field)]))
    : value

/**
 * Renders only a fixed diagnostic vocabulary from inert own data properties.
 * It never enumerates an arbitrary object, invokes an accessor, calls a user
 * coercion hook, or retains an unbounded value. With no `reflection` it reads
 * nothing off an object and renders it as `[uninspected]`; primitives render
 * as they always do.
 *
 * @private
 * @since 1.0.0
 */
export const renderDiagnosticWith = (reflection: Reflection | undefined, value: unknown): string => {
  try {
    // The projection is plain data this module built, so redacting it runs no
    // caller code. It is redacted whole, then bounded, never the other way.
    const redacted = boundDiagnostic(
      Redaction.redactDiagnostic(projectDiagnostic(value, 5, new WeakSet(), reflection))
    )
    return (typeof redacted === "string" ? redacted : JSON.stringify(redacted)).slice(0, 4096)
  } catch {
    return "[unrenderable]"
  }
}

/**
 * {@link renderDiagnosticWith} under the {@link CurrentReflection} in context.
 *
 * @private
 * @since 1.0.0
 */
export const renderDiagnostic = (value: unknown): Effect.Effect<string> =>
  Effect.map(CurrentReflection, (reflection) => renderDiagnosticWith(reflection, value))
