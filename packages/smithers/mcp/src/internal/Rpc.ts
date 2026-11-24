/**
 * JSON-RPC 2.0 envelope encoding for the MCP stdio transport.
 *
 * MCP's stdio transport frames every message as exactly one line of JSON on
 * standard input or output, so this module is pure line-shaped codec: no
 * process, no scheduling, no retry policy. {@link StdioTransport} owns those.
 *
 * @since 1.0.0-rc.0
 */

/**
 * A JSON-RPC call this client sends. Omitting `id` sends a notification, for
 * which the server never replies.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Outbound {
  readonly jsonrpc: "2.0"
  readonly id?: number | undefined
  readonly method: string
  readonly params?: unknown
}

/**
 * Any outbound wire message, including replies to server requests. A reply
 * preserves the server's exact id type rather than normalizing it as a
 * correlation id in the client's pending-request map.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type OutboundMessage = Outbound | {
  readonly jsonrpc: "2.0"
  readonly id: string | number
  readonly result: unknown
} | {
  readonly jsonrpc: "2.0"
  readonly id: string | number
  readonly error: { readonly code: number; readonly message: string }
}

/**
 * A JSON object from server stdout that claims JSON-RPC by carrying its own
 * `jsonrpc` property. Validation happens after parsing so an incorrect version
 * cannot be mistaken for ordinary stdout noise.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Inbound {
  readonly jsonrpc: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

/**
 * A validated JSON-RPC reply, normalized to the numeric request id this
 * client uses for correlation, or an error whose null id cannot be correlated.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Reply = {
  readonly _tag: "Result"
  readonly id: number
  readonly result: unknown
} | {
  readonly _tag: "Error"
  readonly id: number
  readonly code: number
  readonly message: string
  readonly data: unknown
} | {
  readonly _tag: "UncorrelatedError"
  readonly code: number
  readonly message: string
  readonly data: unknown
} | {
  readonly _tag: "Malformed"
  readonly reason: string
}

/**
 * The transport-relevant classification of one parsed JSON-RPC object.
 * Server request ids belong to the opposite direction and must never be
 * looked up in the client's pending-request map.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Classification = { readonly _tag: "Notification" } | {
  readonly _tag: "Request"
  readonly id: string | number
  readonly method: string
  readonly params: unknown
} | Reply

const encoder = new TextEncoder()

/**
 * Encodes one outbound message as a newline-terminated UTF-8 frame.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const encode = (message: OutboundMessage): Uint8Array => encoder.encode(`${JSON.stringify(message)}\n`)

const tagged = (value: unknown): Inbound | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  if (!Object.hasOwn(value, "jsonrpc")) return undefined
  return value as Inbound
}

const json = (line: string): unknown => {
  const trimmed = line.trim()
  if (trimmed === "") return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Parses one line of server output. A blank line, invalid JSON, a non-object,
 * or an object with no own `jsonrpc` property returns `undefined`. MCP servers
 * commonly log to stdout, so output that does not claim to be JSON-RPC is
 * noise rather than a protocol violation. Tagged objects are preserved for
 * {@link classify}, including objects that claim the wrong version.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const parse = (line: string): Inbound | undefined => tagged(json(line))

/**
 * Parses one frame as the messages it carries, in order: one for a JSON-RPC
 * object, one per tagged element for a JSON-RPC batch (a JSON array, which MCP
 * `2025-03-26` lets a server send), none for noise. Each element is read by
 * the rule {@link parse} applies to a whole line, so an element that does not
 * claim JSON-RPC is dropped as noise is.
 *
 * @category conversions
 * @since 1.0.0-rc.19
 */
export const parseFrame = (line: string): ReadonlyArray<Inbound> => {
  const value = json(line)
  const messages: Array<Inbound> = []
  for (const candidate of Array.isArray(value) ? value : [value]) {
    const message = tagged(candidate)
    if (message !== undefined) messages.push(message)
  }
  return messages
}

const malformed = (reason: string): Reply => ({ _tag: "Malformed", reason })

/**
 * Validates and normalizes a parsed inbound object as a reply.
 *
 * Digit-string ids are accepted only in their canonical ASCII decimal form,
 * then converted back to the safe integer id used by the pending-request map.
 * A reply must carry an own id and exactly one own `result` or `error`
 * property. A null id is accepted only for a valid error, which cannot settle
 * any particular request.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const replyOf = (message: Inbound): Reply => {
  if (!Object.hasOwn(message, "id")) return malformed("a reply carried no id")
  const rawId = message.id
  const id = typeof rawId === "number"
    ? rawId
    : typeof rawId === "string" && /^(0|[1-9][0-9]*)$/.test(rawId)
    ? Number(rawId)
    : Number.NaN
  if (rawId !== null && !Number.isSafeInteger(id)) return malformed("a reply id must be a JSON-RPC integer")

  const hasResult = Object.hasOwn(message, "result")
  const hasError = Object.hasOwn(message, "error")
  if (!hasResult && !hasError) return malformed("a reply carried neither result nor error")
  if (hasResult && hasError) return malformed("a reply carried both result and error")
  if (hasResult) {
    if (rawId === null) return malformed("a reply id must be a JSON-RPC integer")
    return { _tag: "Result", id, result: message.result }
  }

  const error = message.error
  if (
    typeof error !== "object" || error === null || Array.isArray(error) ||
    !Number.isInteger((error as { readonly code?: unknown }).code) ||
    typeof (error as { readonly message?: unknown }).message !== "string"
  ) {
    return malformed("a reply carried a malformed error object")
  }
  const record = error as { readonly code: number; readonly message: string; readonly data?: unknown }
  if (rawId === null) {
    return { _tag: "UncorrelatedError", code: record.code, message: record.message, data: record.data }
  }
  return {
    _tag: "Error",
    id,
    code: record.code,
    message: record.message,
    data: record.data
  }
}

/**
 * Classifies a parsed JSON-RPC object for the stdio reader. A wrong version is
 * malformed; a valid own `method` with an own id is a server request, without
 * an id a notification. Every remaining object must satisfy {@link replyOf}.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const classify = (message: Inbound): Classification => {
  if (message.jsonrpc !== "2.0") {
    return malformed("a JSON-RPC message must carry jsonrpc \"2.0\"")
  }
  if (Object.hasOwn(message, "method")) {
    if (typeof message.method !== "string") return malformed("a method must be a string")
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
      return malformed("a method-bearing message cannot also carry result or error")
    }
    if (
      Object.hasOwn(message, "params") &&
      (typeof message.params !== "object" || message.params === null || Array.isArray(message.params))
    ) return malformed("MCP method params must be an object")
    if (!Object.hasOwn(message, "id")) return { _tag: "Notification" }
    const id = message.id
    if (typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id))) {
      return malformed("a server request id must be a string or safe integer")
    }
    return { _tag: "Request", id, method: message.method, params: message.params }
  }
  return replyOf(message)
}
