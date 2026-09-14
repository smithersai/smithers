/**
 * One shape for every way a request can be refused, across the whole stack.
 *
 * Three parties can refuse an act the app started, and until this file they
 * reached the user as three unrelated kinds of thing: plue answered a coded
 * JSON body, the Cloudflare Worker restated one in its own envelope, and a
 * fetch that never got a response became a bare string with the word "failed"
 * in front of it. Only the first carried any verdict, so the interface (and
 * the chat model) had to read English to find out whose problem it was.
 *
 * A `Refusal` is that verdict, carried: which code, whose FAULT, the server's
 * own words, how long it asked us to wait, the status, and who refused. It is
 * built once at each boundary and then rendered, logged, retried on, and handed
 * to the model without any of those re-deciding what happened.
 *
 * The fault is never guessed from prose. plue states it on the wire; the
 * Worker's pass-through keeps `code` and `retry_after` but not `fault`, so a
 * refusal that reached us through the Worker is classified from the VENDORED
 * registry by its code (PlueFailureCodes.ts); only a refusal carrying neither
 * falls back to its status, and a fetch that threw is infra by construction —
 * the user's request never reached anyone who could judge it.
 *
 * @since 1.0.0
 */
import { PLUE_FAILURES, PLUE_FAULTS } from "./PlueFailureCodes.ts"
import type { PlueFailureCode, PlueFault } from "./PlueFailureCodes.ts"

export type { PlueFailureCode, PlueFault }

/**
 * Who refused.
 *
 * - `plue` the platform itself, by a code this build knows.
 * - `worker` the Cloudflare Worker in front of it — its own auth, routing or
 *   envelope, or an upstream refusal it could not attribute.
 * - `client` this app: the request never left, or no response came back.
 *
 * @since 1.0.0
 * @category models
 */
export type RefusalOrigin = "plue" | "worker" | "client"

/**
 * Every way a request can be refused, in one shape.
 *
 * @since 1.0.0
 * @category models
 */
export interface Refusal {
  /** The code, narrowed to the vendored registry; null when the wire named none or one this build predates. */
  readonly code: PlueFailureCode | null
  /** What the wire actually spelled. Shown verbatim, never branched on — a code newer than this build still reaches the user. */
  readonly rawCode: string | null
  readonly fault: PlueFault
  /** The refusing party's own words. Rendered verbatim; this app never rewrites them. */
  readonly message: string
  /**
   * Seconds THIS RESPONSE asked us to wait — its `Retry-After` header or its
   * body's `retry_after`. Null when the response stated none; the registry's
   * pacing for the code is a separate fact, and is used to decide WHETHER a
   * retry is allowed rather than silently standing in for an interval the
   * server did not actually send.
   */
  readonly retryAfter: number | null
  /** The HTTP status, or null when no response arrived at all. */
  readonly status: number | null
  readonly origin: RefusalOrigin
}

const FAULTS: ReadonlySet<string> = new Set(PLUE_FAULTS)

/**
 * The one reviewed ingress for a code that arrived as a string, mirroring plue's own ParseCode.
 *
 * @since 1.0.0
 * @category constants
 */
export const plueFailureCode = (value: unknown): PlueFailureCode | null =>
  typeof value === "string" && Object.hasOwn(PLUE_FAILURES, value) ? value as PlueFailureCode : null

/**
 * The registry row for a code, or null for a code this build does not know.
 *
 * @since 1.0.0
 * @category constants
 */
export const plueFailureEntry = (code: PlueFailureCode | null) => code === null ? null : PLUE_FAILURES[code]

/**
 * The verdict for a refusal that named no code this build knows. plue always
 * states a fault now, so this is the shape of an OLDER deployment or of the
 * Worker's own envelope — and a 5xx that reached us unattributed is the
 * platform's problem, not the caller's.
 *
 * @since 1.0.0
 * @category constants
 */
export const faultOfStatus = (status: number | null): PlueFault => {
  if (status === null) return "infra"
  if (status === 502 || status === 504) return "dependency"
  if (status === 500 || status === 501) return "bug"
  if (status >= 500) return "infra"
  return "user"
}

const textOf = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null

const secondsOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null

/**
 * plue's `Retry-After` is a delta in seconds, never an HTTP date.
 *
 * @since 1.0.0
 * @category constants
 */
export const retryAfterHeader = (headers: { readonly get: (name: string) => string | null }): number | null => {
  const header = headers.get("retry-after")
  if (header === null) return null
  const seconds = Number(header.trim())
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null
}

/**
 * What a boundary knows about a refusal before it is classified.
 *
 * @since 1.0.0
 * @category models
 */
export interface RefusalInput {
  /** The decoded response body, whatever shape it arrived in. */
  readonly body: unknown
  readonly status: number | null
  /** The refusing party's words; the caller has already applied its own fallback. */
  readonly message: string
  /** `Retry-After`, when a response carried one. The body's `retry_after` and the registry stand in when it did not. */
  readonly retryAfterSeconds?: number | null
}

/**
 * The refusal a response describes.
 *
 * Origin is read from the evidence rather than configured: a body that names a
 * code this build knows was written by plue and passed through (the Worker
 * restates prose but preserves `code` and `retry_after` exactly), and anything
 * else that still reached us as a response was refused by the Worker itself.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalOf = (input: RefusalInput): Refusal => {
  const record = typeof input.body === "object" && input.body !== null ? input.body as Record<string, unknown> : {}
  const rawCode = textOf(record.code)
  const code = plueFailureCode(rawCode)
  const entry = plueFailureEntry(code)
  const stated = textOf(record.fault)
  const fault = stated !== null && FAULTS.has(stated)
    ? stated as PlueFault
    : entry?.fault ?? faultOfStatus(input.status)
  return {
    code,
    rawCode,
    fault,
    message: input.message,
    /* The header wins, then the body plue now always writes. What this response said, and nothing inferred. */
    retryAfter: input.retryAfterSeconds ?? secondsOf(record.retry_after) ?? null,
    status: input.status,
    origin: code === null ? "worker" : "plue"
  }
}

/**
 * A request that never got an answer: no server judged it, so no server can be
 * blamed for it and the user certainly cannot. Infra by construction — this is
 * the case that used to reach the chat model as `failed: <fetch message>`.
 *
 * @since 1.0.0
 * @category constants
 */
export const clientRefusal = (error: unknown, message?: string): Refusal => ({
  code: null,
  rawCode: null,
  fault: "infra",
  message: message ?? (error instanceof Error ? error.message : String(error)),
  retryAfter: null,
  status: null,
  origin: "client"
})

/**
 * The refusal as a workspace card persists it (`SessionRefusalSchema`).
 *
 * Structural, not the zod type, so the schema can keep importing this module
 * rather than the other way round. `fault` and `origin` are optional because a
 * card written before the failure registry landed has neither.
 *
 * @since 1.0.0
 * @category models
 */
export interface StoredRefusal {
  readonly status: number
  readonly message: string
  readonly code?: string | null | undefined
  readonly retryAfterSeconds?: number | null | undefined
  readonly fault?: PlueFault | undefined
  readonly origin?: RefusalOrigin | undefined
}

/**
 * A refusal in the shape a card persists. A client refusal has no status; 0 stands for "never answered".
 *
 * @since 1.0.0
 * @category constants
 */
export const storedRefusal = (refusal: Refusal): StoredRefusal => ({
  status: refusal.status ?? 0,
  message: refusal.message,
  code: refusal.rawCode,
  retryAfterSeconds: refusal.retryAfter,
  fault: refusal.fault,
  origin: refusal.origin
})

/**
 * A persisted refusal, read back. A card from before this change carries no
 * verdict, so one is re-derived from its code — the registry knows the fault
 * for every code plue has ever put on the wire, which is exactly why it is
 * vendored rather than trusted to arrive.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalFromStored = (stored: StoredRefusal): Refusal => {
  const code = plueFailureCode(stored.code)
  const status = stored.status === 0 ? null : stored.status
  return {
    code,
    rawCode: stored.code ?? null,
    fault: stored.fault ?? plueFailureEntry(code)?.fault ?? faultOfStatus(status),
    message: stored.message,
    retryAfter: secondsOf(stored.retryAfterSeconds) ?? null,
    status,
    origin: stored.origin ?? (code === null ? "worker" : "plue")
  }
}

/**
 * True when the Worker classified this as the fleet being full rather than one account being at its cap.
 *
 * @since 1.0.0
 * @category constants
 */
export const isCapacityRefusal = (refusal: Refusal): boolean => refusal.code === "no_capacity"

/**
 * Whether the app may run the same request again on its own.
 *
 * Auto-retry is the SERVER'S instruction, never this app's optimism: only a
 * `wait` fault — plue's word for "nothing is wrong, it is not ready yet" — and
 * only with a stated pacing behind it, either on this response or in the
 * registry row for its code. An `infra` refusal is never retried on a timer: a
 * full fleet does not empty because a client asked twice, and a retry loop
 * hides the one fact the user needs, which is that somebody has to buy more of
 * it. A `user` fault retried unchanged fails identically, and a `bug` retried
 * is a bug run twice.
 *
 * @since 1.0.0
 * @category constants
 */
export const mayAutoRetry = (refusal: Refusal): boolean =>
  refusal.fault === "wait" &&
  (refusal.retryAfter !== null || secondsOf(plueFailureEntry(refusal.code)?.retryAfter) !== null)

/**
 * The interval THIS RESPONSE asked for, in milliseconds, or null when it asked
 * for none — in which case the caller uses its own configured wait. The
 * distinction matters: a seam shortens its default in tests, and folding the
 * registry's pacing in here would make that knob a lie.
 *
 * @since 1.0.0
 * @category constants
 */
export const statedRetryDelayMs = (refusal: Refusal): number | null =>
  refusal.retryAfter === null ? null : refusal.retryAfter * 1_000
