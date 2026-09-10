/**
 * The stable code a failing subsystem carries.
 *
 * @since 0.1.0
 */

/**
 * Reads the first of the named fields that carries a string off an unknown
 * failure, or `"unknown"` when none does — the value a refusal quotes as its
 * `cause` so callers branch on a code instead of parsing prose.
 *
 * The accepted fields are the caller's, because what counts as a code
 * differs by seam: the memory door quotes only a shipped `code`, while the
 * author seat also accepts a tagged failure's `_tag`, the one stable thing
 * an Effect error always carries. Naming them per call site keeps one reader
 * from silently widening either contract.
 *
 * @private
 * @since 0.1.0
 */
export const failureCode = (error: unknown, fields: ReadonlyArray<string>): string => {
  if (typeof error === "object" && error !== null) {
    const record = error as { readonly [field: string]: unknown }
    for (const field of fields) {
      const value = record[field]
      if (typeof value === "string") return value
    }
  }
  return "unknown"
}
