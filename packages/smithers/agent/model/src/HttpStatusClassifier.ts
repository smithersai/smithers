/**
 * Shared HTTP status and provider vocabulary classification.
 *
 * @since 0.1.0
 */

import { isContextOverflow, isQuotaExhausted, type ModelErrorCode } from "./ModelError.vibe"

/**
 * Where a failure's words came from.
 *
 * `provider` is the provider's own error envelope: a `code`/`type` and the
 * `message` beside it. `opaque` is every other text a failed call leaves
 * behind — a gateway's page, a proxy's sentence, a body that quotes the
 * request or an agent's own report.
 *
 * Only provider fields establish named quota/rate limits; opaque bodies
 * follow the HTTP status for those classes. Likewise, content-policy words
 * in an opaque 5xx page do not override its transient server status. Other
 * classifications retain their vocabulary checks for gateway verdicts.
 *
 * @category models
 * @since 1.0.0-rc.7
 */
export type MessageSource = "provider" | "opaque"

/**
 * Classifies normalized provider error fields. Protocols own envelope decoding
 * and provider-specific overrides; HTTP and vocabulary precedence live here.
 *
 * `source` is stated by every caller rather than defaulted: a classifier that
 * assumes its words came from a provider is how process output became a quota
 * refusal.
 *
 * @category utilities
 * @since 0.1.0
 */
export const classifyHttpStatus = (
  status: number | undefined,
  code: string | undefined,
  message: string,
  source: MessageSource
): ModelErrorCode => {
  const normalized = `${code ?? ""} ${message}`.toLowerCase()
  // Only the provider's own fields may name a limit no status carries.
  const named = source === "provider"
  if (status === 401 || status === 403) return "authentication"
  if (status === 402 && code === "out_of_credit") return "out_of_credit"
  if (status === 402 || (named && isQuotaExhausted(code, message))) return "quota_exceeded"
  if (
    /authentication|invalid[-_\s]?api[-_\s]?key|incorrect[-_\s]?api[-_\s]?key|permission[-_\s]?denied/.test(normalized)
  ) {
    return "authentication"
  }
  if (status === 429 || (named && /rate[-_\s]?limit|usage[-_\s]?limit|too many requests/.test(normalized))) {
    return "rate_limited"
  }
  if (
    (named || status === undefined || status < 500) &&
    /content[-_\s]?policy|content[-_\s]?filter|safety/.test(normalized)
  ) return "content_policy"
  // Quota and overflow must precede their generic invalid-request envelopes.
  if (isContextOverflow(code, message)) return "context_overflow"
  if (
    status === 400 || status === 404 || status === 409 || status === 413 || status === 422 ||
    /invalid[-_\s]?request/.test(normalized)
  ) return "invalid_request"
  // A stream that fails after HTTP 200 carries no status, only the provider's
  // words: ChatGPT's `response.failed` says "Our servers are currently
  // overloaded" and Anthropic's event says `overloaded_error`. Both are the
  // provider's transient fault, so they retry like the 5xx they stand for.
  if (
    (status !== undefined && status >= 500) ||
    /server[-_\s]?error|internal[-_\s]?error|overloaded|service[-_\s]?unavailable/.test(normalized)
  ) {
    return "provider_internal"
  }
  return "unknown"
}
