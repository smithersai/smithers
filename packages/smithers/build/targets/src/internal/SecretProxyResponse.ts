/**
 * Bounded upstream HTTP response coordination, independent of native transport construction.
 * @since 1.0.0
 */

import type { Buffer } from "node:buffer"
import type * as NodeHttp from "node:http"
import type { RequestBoundary } from "../SecretProxy.ts"
import * as HttpPolicy from "./HttpProxyPolicy.ts"

/**
 * Request-local response lifecycle supplied by the proxy host.
 * @since 1.0.0
 * @private
 */
export interface ResponseContext {
  readonly isSettled: () => boolean
  readonly failError: (error: NodeJS.ErrnoException) => void
  readonly fail: (message: string) => void
  readonly chunks: Array<Buffer>
  readonly concat: typeof Buffer.concat
  readonly boundary: Pick<RequestBoundary, "redact" | "redactBytes">
  readonly hopByHop: ReadonlySet<string>
  readonly method: string | undefined
  readonly complete: (status: number, headers: Record<string, string | Array<string>>, body: Buffer) => void
}

/**
 * Observes one real upstream response while preserving settlement and output bounds.
 * @since 1.0.0
 * @private
 */
export const observeUpstream = (
  upstreamResponse: NodeHttp.IncomingMessage,
  context: ResponseContext,
  maximumBytes: number
): void => {
  upstreamResponse.once("error", context.failError)
  const endedEarly = () => context.fail("upstream request failed: upstream response ended early")
  upstreamResponse.once("aborted", endedEarly)
  upstreamResponse.once("close", endedEarly)
  if (context.isSettled()) {
    upstreamResponse.destroy()
    return
  }
  const encoding = upstreamResponse.headers["content-encoding"]
  if (encoding !== undefined && encoding !== "identity") {
    context.fail("upstream returned an encoded response")
    return
  }
  let responseBytes = 0
  upstreamResponse.on("data", (chunk: Buffer) => {
    if (context.isSettled()) return
    responseBytes += chunk.byteLength
    if (responseBytes > maximumBytes) {
      context.fail("upstream response is too large")
      return
    }
    context.chunks.push(chunk)
  })
  upstreamResponse.on("end", () => {
    if (context.isSettled()) return
    const responseHeaders: Record<string, string | Array<string>> = {}
    const nominated = HttpPolicy.connectionHeaderNames(upstreamResponse.headers.connection)
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      const lower = name.toLowerCase()
      if (
        value !== undefined && !context.hopByHop.has(lower) && !nominated.has(lower) &&
        lower !== "content-length" && lower !== "content-encoding"
      ) {
        responseHeaders[name] = Array.isArray(value)
          ? value.map(context.boundary.redact)
          : context.boundary.redact(value)
      }
    }
    const redacted = context.boundary.redactBytes(context.concat(context.chunks))
    // HEAD and 304 carry metadata about a representation, not a body
    // whose length can be recomputed after redaction.
    if (context.method === "HEAD" || upstreamResponse.statusCode === 304) {
      const length = upstreamResponse.headers["content-length"]
      if (length !== undefined && !nominated.has("content-length")) responseHeaders["content-length"] = length
    } else {
      responseHeaders["content-length"] = String(redacted.byteLength)
    }
    context.complete(HttpPolicy.upstreamStatus(upstreamResponse.statusCode), responseHeaders, redacted)
  })
}
