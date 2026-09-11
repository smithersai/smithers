/*
 * The context a domain seam factory receives from the controller: the tapped
 * fetch, the store, and the transcript helpers. Seams own one backend domain
 * each (issues, landings, keys, …), dispatch typed transitions, and answer
 * the [flow result contract](../../flows/entries/Declare.ts): an honest error
 * string, void for success without data, or { readonly value: string } for
 * success with data. Model-invocable reads must return a bounded value built
 * from the same parsed payload as their card: the model reads the value,
 * never the card. See [FilesSeam](./FilesSeam.ts) for a read example.
 * Cards carry the human presentation; raw backend payloads are not results.
 */
import { isRecord } from "@smthrs/canonical/Record"
import type { AppStore } from "../AppStore"

export type SeamFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface SeamContext {
  readonly http: SeamFetch
  readonly baseUrl: string
  readonly store: AppStore
  readonly dispatch: AppStore["dispatch"]
  /** The acting principal for dispatches: "user", or "smithers" in the agent's actor projection (ActorBindings). */
  readonly actor: () => "user" | "smithers"
  /** The next transcript ordinal — new cards surface at the end, never mid-history. */
  readonly nextOrdinal: () => number
}

/** A bounded model-readable answer; the card retains the full parsed payload. */
export const readResult = (value: string): { readonly value: string } => {
  const cap = 16_000
  const suffix = "\n[truncated]"
  return { value: value.length <= cap ? value : value.slice(0, cap - suffix.length) + suffix }
}

/**
 * The honest message out of a failed seam response, bounded and fallback-safe.
 *
 * ONLY a message the upstream addressed to a person is surfaced: the `message`
 * or `error` field of a JSON body. Anything else is transport plumbing with no
 * contract with this product — a router's `404 page not found`, an HTML error
 * page, a stack trace — and reads to the user as a debug string leaking through
 * the UI (§28.5). The caller's fallback already names what failed in the
 * product's own voice, so that is what a plumbing body gets.
 */
export const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  return errorMessage(await response.json().catch(() => null), fallback)
}

/** The human-facing message in an already decoded response. */
export const errorMessage = (body: unknown, fallback: string): string => {
  if (!isRecord(body)) return fallback
  if (typeof body.message === "string" && body.message !== "") return body.message.slice(0, 240)
  if (typeof body.error === "string" && body.error !== "") return body.error.slice(0, 240)
  // Native routes use { error: { code, message } }.
  if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message !== "") {
    return body.error.message.slice(0, 240)
  }
  return fallback
}

/*
 * A URL off a DTO that the app will follow (an install link opened in the
 * system browser, a Linear link rendered as an href): only an https URL on
 * the named host is worth linking. Anything else — a `javascript:` scheme,
 * a look-alike host, a malformed value — answers null and the card renders
 * the text without a link. One check for every DTO href (review finding 10:
 * the install URL was vetted, the Linear URL was not).
 */
export const trustedHttpsUrl = (value: string, host: string): string | null => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === host ? url.toString() : null
  } catch {
    return null
  }
}

/*
 * Lane sync (ADR 0005 "Rate limits"): a refused GitHub-proxied call. plue's
 * structured 429 (`pkg/errors.CodeGitHubRateLimited`, raised by
 * `internal/services/github_proxy.go`) answers `{ code:
 * "github_rate_limited", message, limit, remaining, reset_at, retry_after }`;
 * when the body carries it the caller gets the rate-limit facts for the
 * card's line (`… · 0 of 5 000 · resets 12:40 · Retry after`) beside the
 * honest message. Any other refusal is the verbatim message alone — no reset
 * is ever invented for a plain 429.
 */
export interface GitHubRefusal {
  readonly message: string
  readonly rateLimit?: { readonly limit: number; readonly remaining: number; readonly resetAt: string | null }
}

export const readGitHubRefusal = async (response: Response, fallback: string): Promise<GitHubRefusal> => {
  const text = (await response.text().catch(() => "")).trim()
  if (text !== "") {
    try {
      const body = JSON.parse(text) as {
        code?: unknown
        message?: unknown
        error?: unknown
        limit?: unknown
        remaining?: unknown
        reset_at?: unknown
      }
      const message = typeof body.message === "string" && body.message !== ""
        ? body.message.slice(0, 240)
        : typeof body.error === "string" && body.error !== ""
        ? body.error.slice(0, 240)
        : fallback
      if (
        body.code === "github_rate_limited" &&
        typeof body.limit === "number" && Number.isInteger(body.limit) &&
        typeof body.remaining === "number" && Number.isInteger(body.remaining)
      ) {
        return {
          message,
          rateLimit: {
            limit: body.limit,
            remaining: body.remaining,
            resetAt: typeof body.reset_at === "string" && body.reset_at !== "" ? body.reset_at : null
          }
        }
      }
      return { message }
    } catch {
      // Not JSON at all: plumbing, never copy.
      return { message: fallback }
    }
  }
  return { message: fallback }
}
