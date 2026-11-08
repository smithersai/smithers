/**
 * The structural refinement of a {@link SmithersError}, written in
 * TypeScript because it must catch what a caller's property getter throws: a
 * `.vibe` file's `catch` receives typed failures only (VibeLang D282).
 *
 * @since 1.0.0
 */

import { isSmithersErrorCode } from "./ErrorCode.ts"
import type { SmithersError } from "./SmithersError.vibe"

/**
 * Whether `value` has the structural fields of a {@link SmithersError}.
 *
 * Use this refinement when a consumer must accept an instance produced by
 * another module instance and needs more assurance than a forgeable `name`
 * check. The value must still be an `Error` with a code from the documented
 * closed vocabulary and string summary and documentation URL fields.
 * `details`, when present, must be a non-null object.
 *
 * Inspecting the value runs caller code: a property getter, or a proxy trap
 * reached by the prototype lookup, belongs to whoever built the error. Every
 * read is inside a `try`, so an inspection that throws answers `false` instead
 * of escaping and replacing the failure being classified.
 *
 * @param value - Any value to inspect, including errors from another module copy.
 * @returns Whether the required structural fields match; throwing inspection returns `false`.
 * @category refinements
 * @since 1.0.0
 */
export const hasSmithersErrorShape = (value: unknown): value is SmithersError => {
  try {
    if (!(value instanceof Error)) return false
    const details = (value as SmithersError).details
    return isSmithersErrorCode((value as SmithersError).code) &&
      typeof (value as SmithersError).summary === "string" &&
      typeof (value as SmithersError).docsUrl === "string" &&
      (details === undefined || (typeof details === "object" && details !== null && !Array.isArray(details)))
  } catch {
    return false
  }
}
