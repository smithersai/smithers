/**
 * A failure's name for a log line: an error's name or a tagged value's tag, never its message, which can quote what
 * someone wrote or a host's text. An `UnknownError` from `Effect.tryPromise`, or a wrapper with a `cause`, such as
 * `PersistenceUnavailable`, is named by what it wraps when `unwrap` names its tag.
 *
 * @since 0.2.0
 */

/**
 * Names a failure without its message.
 *
 * @private
 * @since 0.2.0
 */
export const errorName = (failure: unknown, unwrap: ReadonlyArray<string> = ["UnknownError"]): string => {
  const tag = typeof failure === "object" && failure !== null && "_tag" in failure ? String(failure._tag) : undefined
  if (tag !== undefined && unwrap.includes(tag)) {
    return errorName((failure as { readonly cause?: unknown }).cause, unwrap)
  }
  const name = typeof failure === "object" && failure !== null && "name" in failure ? failure.name : undefined
  return tag ?? (typeof name === "string" && /^[A-Za-z@][A-Za-z0-9_./:@-]{0,127}$/.test(name) ? name : typeof failure)
}
