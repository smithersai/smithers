/**
 * A failure's name for a log line: an error's name or a tagged value's tag, never its message, which can quote what
 * someone wrote or a host's text. An `UnknownError` from `Effect.tryPromise`, or a wrapper with a `cause`, such as
 * `PersistenceUnavailable`, is named by what it wraps when `unwrap` names its tag.
 *
 * @internal
 */
export const errorName = (failure: unknown, unwrap: ReadonlyArray<string> = ["UnknownError"]): string => {
  const tag = typeof failure === "object" && failure !== null && "_tag" in failure ? String(failure._tag) : undefined
  if (tag !== undefined && unwrap.includes(tag)) return errorName((failure as { readonly cause?: unknown }).cause, unwrap)
  return tag ?? (failure instanceof Error ? failure.name : typeof failure)
}
