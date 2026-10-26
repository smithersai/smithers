// A failure's code for a log line (docs/observability.md#rules): the browser's twin of worker/ErrorCode.ts. A log line
// names what went wrong by this code and never by a message, which can quote what someone wrote or a server's text.
// Nothing here imports a library, so a view, a step and the engine worker can all use it.

const identifier = /^[A-Za-z0-9_.:/@-]{1,64}$/

const asCode = (value: unknown): string | undefined =>
  typeof value === "string" && identifier.test(value) ? value : undefined

/**
 * A failure's code: `sql:<reason>` for a SQL failure, `http:<reason>` for an Effect HTTP client's (`TransportError`,
 * `StatusCodeError`, ...), else its `code` (such as a refusal's), else its `_tag`, else an error's name when it isn't
 * plain `Error`, else `unknown`. A value that isn't a short identifier is skipped.
 */
export const codeOf = (failure: unknown): string => {
  if (typeof failure !== "object" || failure === null) return "unknown"
  const { code, _tag, name, reason } = failure as {
    readonly code?: unknown
    readonly _tag?: unknown
    readonly name?: unknown
    readonly reason?: { readonly _tag?: unknown }
  }
  const prefix = _tag === "SqlError" ? "sql" : _tag === "HttpClientError" ? "http" : undefined
  if (prefix !== undefined) {
    const kind = asCode(reason?._tag)
    if (kind !== undefined) return `${prefix}:${kind}`
  }
  return asCode(code) ?? asCode(_tag) ?? (name === "Error" ? undefined : asCode(name)) ?? "unknown"
}
