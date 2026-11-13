/**
 * HTTP proxy header and destination policy, independent of the socket host.
 * @since 1.0.0
 */

/**
 * Header names nominated by Connection; each field is case-insensitive and comma-separated.
 * @category policy
 * @since 1.0.0
 */
export const connectionHeaderNames = (value: string | ReadonlyArray<string> | undefined): ReadonlySet<string> => {
  const fields = Array.isArray(value) ? value : value === undefined ? [] : [value as string]
  return new Set(fields.flatMap((field) => field.split(",")).map((field) => field.trim().toLowerCase()).filter(Boolean))
}

/**
 * Keeps only a bounded native-style code from an upstream failure.
 * @category diagnostics
 * @since 1.0.0
 */
export const upstreamFailure = (error: { readonly code?: unknown }): string => {
  const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? `: ${error.code}` : ""
  return `upstream request failed${code}`
}

/**
 * The port an HTTP request uses when its URL omits an explicit authority port.
 * @category policy
 * @since 1.0.0
 */
export const destinationPort = (target: URL): string | number =>
  target.port === "" ? (target.protocol === "https:" ? 443 : 80) : target.port

/**
 * Normalizes the optional native request target before routing.
 * @since 1.0.0
 * @private
 */
export const requestTarget = (value: string | undefined): string => value ?? ""

/**
 * Preserves a native upstream status and fails closed if none was supplied.
 * @since 1.0.0
 * @private
 */
export const upstreamStatus = (value: number | undefined): number => value ?? 502

/**
 * Names declarations without exposing values when HTTP rejects a request.
 * @since 1.0.0
 * @private
 */
export const unrepresentableRequest = (names: ReadonlyArray<string>): string =>
  names.length === 0
    ? "the request could not be represented as an http request"
    : `the declared secret ${names.join(", ")} produced an invalid request target`

/**
 * Resolves an origin-form request without allowing URL normalization to change its audience.
 * @since 1.0.0
 * @private
 */
export const brokeredTarget = (audience: string, requestTarget: string): URL | string => {
  const refusal = "brokered origin requires an origin-form request target"
  if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) return refusal
  const target = new URL(requestTarget, audience)
  return target.origin === audience ? target : refusal
}

/**
 * Buffers an upload within its byte bound and reports its first overflow once.
 * @since 1.0.0
 * @private
 */
export const appendUploadChunk = <A extends Uint8Array>(
  state: { bytes: number; rejected: boolean },
  chunks: Array<A>,
  chunk: A,
  maximumBytes: number
): boolean => {
  if (state.rejected) return false
  state.bytes += chunk.byteLength
  if (state.bytes > maximumBytes) {
    state.rejected = true
    chunks.length = 0
    return true
  }
  chunks.push(chunk)
  return false
}
