/**
 * Shared HTTP status and provider vocabulary classification.
 *
 * @since 0.1.0
 */

import { isContextOverflow, isQuotaExhausted, type ModelErrorCode } from "./ModelError.ts"

/**
 * Where a failure's words came from.
 *
 * `provider` is the provider's own error envelope: a `code`/`type` and the
 * `message` beside it. `opaque` is every other text a failed call leaves
 * behind — a gateway's page, a proxy's sentence, a body that quotes the
 * request or an agent's own report.
 *
 * Only provider fields establish named quota/rate limits; opaque bodies
 * follow the HTTP status for those classes. Likewise, sign-in, content-policy
 * and overflow words in an opaque 5xx page do not override its transient
 * server status. Other
 * classifications retain their vocabulary checks for gateway verdicts.
 *
 * @category models
 * @since 1.0.0-rc.7
 */
export type MessageSource = "provider" | "opaque"

// Statuses that refuse the request itself. Their messages quote the request
// back (`Invalid schema for function 'get_rate_limit'`), so a quoted span is the
// request's words, never the provider naming a limit, a sign-in or a refusal.
const requestStatuses: ReadonlySet<number> = new Set([400, 404, 409, 413, 422])
const quotedSpan = /(?<!\w)(['"`])[^'"`]*\1(?!\w)/g

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
  const prose = status !== undefined && requestStatuses.has(status) ? message.replace(quotedSpan, " ") : message
  const normalized = `${code ?? ""} ${prose}`.toLowerCase()
  // Only the provider's own fields may name a limit no status carries.
  const named = source === "provider"
  if (status === 401 || status === 403) return "authentication"
  if (status === 402 && code === "out_of_credit") return "out_of_credit"
  if (status === 402 || (named && isQuotaExhausted(code, prose))) return "quota_exceeded"
  // A 5xx is the server failing; sign-in words on its page are not the caller's fault.
  if (
    (status === undefined || status < 500) &&
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
  if ((named || status === undefined || status < 500) && isContextOverflow(code, message)) return "context_overflow"
  if (
    (status !== undefined && requestStatuses.has(status)) ||
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
