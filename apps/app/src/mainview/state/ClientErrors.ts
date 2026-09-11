/*
 * The client half of the crash sink. A browser that throws in production
 * reports it to the Worker at /api/client-errors, which logs it and keeps the
 * last reports in a bounded Durable Object for GET /api/admin/errors. Without
 * this the first anyone hears of a broken flow is a user mentioning it.
 *
 * The behaviour lived inline in main.tsx, where `void main()` runs at import
 * time and nothing about it could be asserted. It is a module so the contract
 * with the Worker — the path, the body shape, the size the route will accept —
 * is testable, and so a rename on either side turns a test red instead of
 * quietly pointing every crash report at a 404. main.tsx imports this module;
 * there is no second copy of the reporter to drift from it.
 *
 * Three bounds, each for a reason:
 *   - the path is a constant, not a literal at the call site, so the client
 *     and the Worker route cannot drift apart unnoticed;
 *   - the posted body is cut to CLIENT_ERROR_BODY_MAX_BYTES, so one runaway
 *     stack cannot exceed the route's cap and be answered 413;
 *   - a page reports at most CLIENT_ERROR_REPORT_LIMIT times, so an error in
 *     a render loop cannot turn one broken tab into a request storm.
 *
 * Reporting is fire-and-forget in both directions: it never throws, never
 * awaits, and never surfaces its own failure. A page that just crashed is not
 * helped by the report crashing too.
 */

/** The Worker route. Must equal `CLIENT_ERRORS_PATH` in apps/server/src/index.ts. */
export const CLIENT_ERRORS_PATH = "/api/client-errors"

/** Reports one page may send. An error inside a render loop fires without end. */
export const CLIENT_ERROR_REPORT_LIMIT = 20

/**
 * The largest body this client will post, in UTF-8 bytes.
 *
 * The number and the unit are both the Worker's: apps/server/src/index.ts
 * refuses a report with `body.byteLength > CLIENT_ERROR_MAX_BODY`, where
 * CLIENT_ERROR_MAX_BODY is 16 * 1024 and byteLength counts the bytes on the
 * wire. A character count cannot agree with that. JSON.stringify leaves
 * non-ASCII literal, so a stack written in Japanese costs three bytes a
 * character, and it escapes a control character or a lone surrogate to six.
 * Bounding characters therefore under-measures by up to 6x, exactly for the
 * users whose crash reports are hardest to reproduce: the client believes it
 * reported, the route answers 413, and the report is lost.
 *
 * The Worker's own log applies a second, softer bound after this one: it keeps
 * the first CLIENT_ERROR_RECORD_MAX_BYTES (4 KiB) of each record and says so in
 * the stored text (apps/server/src/clientErrorLog.ts). That truncation is
 * stated, and the full text is still in the worker tail, so the client posts
 * up to the route's cap rather than pre-cutting to the log's.
 */
export const CLIENT_ERROR_BODY_MAX_BYTES = 16 * 1024

/**
 * Bytes of page path kept. The path is overhead on every report and a path
 * longer than this is not one anyone reads; capping it first leaves the rest
 * of the budget to the stack, which is the part worth having.
 */
export const CLIENT_ERROR_URL_MAX_BYTES = 1024

export type ClientErrorKind = "error" | "unhandledrejection"

/** Exactly what is posted. The Worker stores this verbatim under `report`. */
export interface ClientErrorReport {
  readonly kind: ClientErrorKind
  readonly message: string
  readonly url: string
  readonly at: string
}

/*
 * Narrower than `typeof fetch` on purpose: the reporter only ever posts one
 * string path, and the wide type drags in the platform's extra statics
 * (`preconnect`), which no test double can satisfy.
 */
export type ClientErrorFetch = (input: string, init: RequestInit) => Promise<Response>

export interface ClientErrorReporterOptions {
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetchImpl?: ClientErrorFetch
  readonly limit?: number
  readonly now?: () => Date
  /** The page the report came from. Defaults to the current pathname. */
  readonly pathname?: () => string
}

export interface ClientErrorReporter {
  readonly report: (kind: ClientErrorKind, error: unknown) => void
  /** Reports sent so far, for asserting the cap. */
  readonly reported: () => number
}

/*
 * A stack is the part worth reading, so it wins over the message when the
 * thrown value carries one. A rejection reason is frequently not an Error at
 * all — a string, a Response, undefined — and String() keeps those legible
 * rather than dropping them. Values with throwing conversion hooks fall back
 * to an object label, or a fixed label if even that conversion fails.
 */
export const errorMessage = (error: unknown): string => {
  try {
    return error instanceof Error ? (error.stack ?? error.message) : String(error)
  } catch {
    try {
      return Object.prototype.toString.call(error)
    } catch {
      return "Unknown error"
    }
  }
}

const encoder = new TextEncoder()

/** UTF-8 bytes, the unit the Worker measures a request body in. */
export const byteLength = (text: string): number => encoder.encode(text).length

/*
 * Cutting to a byte budget cannot be done by counting characters: a UTF-16
 * code unit is worth one to three UTF-8 bytes, and up to six once JSON escapes
 * it. So the cut is proportional and then re-measured. The first pass lands
 * close for any alphabet and the loop makes it exact. Neither pass can shrink
 * the text to nothing, which is what subtracting the byte excess from a
 * character count does on non-ASCII input.
 */
const cutToBytes = (text: string, maxBytes: number): string => {
  let head = text.length > maxBytes ? text.slice(0, maxBytes) : text
  let size = byteLength(head)
  while (size > maxBytes && head.length > 0) {
    head = head.slice(0, Math.min(head.length - 1, Math.floor((head.length * maxBytes) / size)))
    size = byteLength(head)
  }
  return head
}

/**
 * The exact bytes posted for one report, already inside the route's cap.
 *
 * Building the body and bounding it are one step on purpose: the escaping
 * JSON.stringify applies is part of what the Worker weighs, so the serialized
 * string is the only honest place to measure. There is no way to build a
 * report body that skips this bound.
 */
export const clientErrorBody = (
  kind: ClientErrorKind,
  error: unknown,
  at: Date,
  url: string
): string => {
  const page = cutToBytes(url, CLIENT_ERROR_URL_MAX_BYTES)
  const stamp = at.toISOString()
  const bodyFor = (message: string): string =>
    JSON.stringify({ kind, message, url: page, at: stamp } satisfies ClientErrorReport)
  // Cheap pre-cut: a code unit costs at least one byte in the body, so
  // nothing past the cap can survive it, and a 5 MB stack is never
  // serialized whole.
  let message = errorMessage(error).slice(0, CLIENT_ERROR_BODY_MAX_BYTES)
  let body = bodyFor(message)
  // The message is what gives, because the other three fields are the
  // report's identity: a body with no kind, page or time reports nothing.
  const fixed = byteLength(bodyFor(""))
  while (byteLength(body) > CLIENT_ERROR_BODY_MAX_BYTES && message.length > 0) {
    const available = CLIENT_ERROR_BODY_MAX_BYTES - fixed
    const used = byteLength(body) - fixed
    message = message.slice(
      0,
      Math.max(0, Math.min(message.length - 1, Math.floor((message.length * available) / used)))
    )
    body = bodyFor(message)
  }
  return body
}

const currentPathname = (): string => typeof globalThis.location === "undefined" ? "" : globalThis.location.pathname

export const createClientErrorReporter = (
  options?: ClientErrorReporterOptions
): ClientErrorReporter => {
  const limit = options?.limit ?? CLIENT_ERROR_REPORT_LIMIT
  const now = options?.now ?? ((): Date => new Date())
  const pathname = options?.pathname ?? currentPathname
  let sent = 0

  const report = (kind: ClientErrorKind, error: unknown): void => {
    try {
      if (sent >= limit) return
      // Counted before construction and sending: the cap bounds attempts,
      // so any failure cannot be retried into a storm.
      sent += 1
      const body = clientErrorBody(kind, error, now(), pathname())
      // keepalive so a report survives the navigation that a crash often
      // triggers. The browser allows 64 KiB of keepalive bodies in flight
      // at once, which is four reports at this cap, and a crashing page
      // sends them one at a time.
      const post = options?.fetchImpl ?? globalThis.fetch
      const sending = post(CLIENT_ERRORS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true
      })
      void Promise.resolve(sending).catch(() => undefined)
    } catch {
      // Construction, metadata callbacks, and synchronous fetch failures
      // must not become a second uncaught error on top of the first one.
    }
  }

  return { report, reported: (): number => sent }
}
