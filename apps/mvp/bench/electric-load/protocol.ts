// Electric's HTTP shape protocol as one device follows it, the way the app's collections do through
// @smthrs/effect-electric: the initial request at offset -1, catch-up requests on the handle and offset each answer
// names until one says it is up to date, then live long-polls carrying the cursor. A 409 starts the shape over on the
// handle it names; a 5xx, a 429 or no answer is tried again after the collections' default sync policy (1 s, doubling to
// 10 s, jittered) or the answer's `retry-after`, whichever is longer. Pure, so protocol.test.ts proves it.

/** Where a device is in one shape. */
export interface Position {
  readonly handle?: string
  readonly offset: string
  readonly live: boolean
  readonly cursor?: string
  readonly expiredHandle?: string
  /** Failures in a row, which set the next wait. */
  readonly failures: number
}

export const START: Position = { offset: "-1", live: false, failures: 0 }

/** Electric's protocol parameters: run.ts sets them, and routes.ts strips them from the routes it records. */
export const PROTOCOL_PARAMS: ReadonlySet<string> = new Set([
  "offset", "handle", "live", "cursor", "log", "expired_handle", "live_sse", "experimental_live_sse", "cache-buster",
  "columns", "table", "where", "params", "replica",
])

/** The request URL for `position` on `route` (its own parameters) at `target`. */
export const urlOf = (target: string, path: string, params: Readonly<Record<string, string>>, position: Position): string => {
  const url = new URL(path, target)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  url.searchParams.set("offset", position.offset)
  if (position.handle !== undefined) url.searchParams.set("handle", position.handle)
  if (position.expiredHandle !== undefined) url.searchParams.set("expired_handle", position.expiredHandle)
  if (position.live) {
    url.searchParams.set("live", "true")
    url.searchParams.set("cursor", position.cursor ?? "")
  }
  return url.href
}

/** What one answer did: the next position, the wait before sending it, and whether the shape is now up to date. */
export interface Step {
  readonly next: Position
  readonly waitMs: number
  readonly upToDate: boolean
  /** Whether the answer carried changes (a non-empty batch with an operation). */
  readonly changed: boolean
}

/** The wait after `failures` failures in a row, before jitter: 1 s doubling to 10 s. */
export const backoffMs = (failures: number): number => Math.min(10_000, 1_000 * 2 ** Math.max(0, failures - 1))

/** Seconds in a `retry-after` header as ms, or 0. */
const retryAfterMs = (value: string | null): number => {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

/**
 * The step after an answer with `status`, `headers` and `body` (the batch's text), or after no answer (`status`
 * undefined). `jitter` is in [0.8, 1.2].
 */
export const step = (
  position: Position,
  status: number | undefined,
  headers: { readonly get: (name: string) => string | null },
  body: string,
  jitter = 1,
): Step => {
  if (status === undefined || status >= 500 || status === 429) {
    const failures = position.failures + 1
    const waitMs = Math.max(Math.round(backoffMs(failures) * jitter), status === undefined ? 0 : retryAfterMs(headers.get("retry-after")))
    return { next: { ...position, failures }, waitMs, upToDate: false, changed: false }
  }
  if (status === 409) {
    const handle = headers.get("electric-handle") ?? undefined
    return {
      next: { ...START, ...(handle === undefined ? {} : { handle }), ...(position.handle === undefined ? {} : { expiredHandle: position.handle }) },
      waitMs: 0,
      upToDate: false,
      changed: false,
    }
  }
  if (status >= 400) return { next: { ...position, failures: position.failures + 1 }, waitMs: 10_000, upToDate: false, changed: false }
  const upToDate = headers.get("electric-up-to-date") !== null
  const cursor = headers.get("electric-cursor") ?? position.cursor
  return {
    next: {
      handle: headers.get("electric-handle") ?? position.handle,
      offset: headers.get("electric-offset") ?? position.offset,
      live: position.live || upToDate,
      ...(cursor === undefined ? {} : { cursor }),
      failures: 0,
    },
    waitMs: 0,
    upToDate,
    changed: body.includes('"operation"'),
  }
}
