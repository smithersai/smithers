import { Context, Effect, Exit, Layer, Logger, Tracer } from "effect"

// What went wrong in this tab lately (docs/features/bugs.md#what-a-report-carries), from the tab's own observability:
// beside the OTLP exporter that relays the tab's records to ChatApi (src/boot.ts), a logger and a tracer keep the
// latest error- and warning-level log events, failed `/api/` requests, and uncaught errors and unhandled rejections, in
// a ring a bug report reads. Each is its record's name and stable code, a trace id and a time: never a message, an
// argument, a URL's query or anything a person wrote (OBS-5). A log event counts only when its name is a record the
// relay keeps (src/telemetry.ts), whose fields are content-free by contract; its code comes from those fields alone.

/** How many of its latest error records a tab keeps. */
export const ERRORS_KEPT = 30

/**
 * One thing that went wrong: when, what kind (`log`, a failed `/api/` request `http`, an uncaught error `page`), its
 * record's name (`flow.dispatch`, `GET /api/runs`, `page error`), its stable code, and the trace it happened in.
 */
export interface ErrorRecord {
  readonly at: string
  readonly kind: "log" | "http" | "page"
  readonly name: string
  readonly code: string | null
  readonly traceId: string | null
}

/** The page's own records of what nothing caught (src/boot.ts `logPageErrors`). */
const PAGE_RECORDS: ReadonlySet<string> = new Set(["page error", "unhandled rejection"])

/** The fields a log event's stable code is read from, in order: never a message. */
const CODE_FIELDS = ["errorCode", "code", "refusal", "reason", "error.type", "exception.type"] as const

const CODE = /^[\w./:-]{1,64}$/
const TRACE = /^[0-9a-f]{32}$/

/** `value` when it is a stable code: a short token with no spaces, so never prose. */
const codeOf = (value: unknown): string | null => (typeof value === "string" && CODE.test(value) ? value : null)

/** `traceId`, padded as OTLP pads it, when it is a trace id. */
const traceOf = (traceId: string | undefined): string | null => {
  const padded = traceId?.padStart(32, "0")
  return padded !== undefined && TRACE.test(padded) ? padded : null
}

/** A log event as the ring reads it. */
export interface LogEvent {
  readonly message: unknown
  readonly level: string
  readonly annotations: Readonly<Record<string, unknown>>
  readonly traceId?: string | undefined
  readonly date: Date
}

/**
 * The record of an error- or warning-level log event whose name is one of `records`: `page` for an uncaught error or
 * rejection, coded by the error's name; `log` otherwise, coded by its first stable code field. Nothing for any other.
 */
export const fromLog = (event: LogEvent, records: ReadonlySet<string>): ErrorRecord | undefined => {
  if (event.level !== "Error" && event.level !== "Warn" && event.level !== "Fatal") return undefined
  const message = Array.isArray(event.message) ? event.message[0] : event.message
  if (typeof message !== "string" || !records.has(message)) return undefined
  const page = PAGE_RECORDS.has(message)
  const code = page
    ? codeOf(event.annotations.name)
    : CODE_FIELDS.map((field) => codeOf(event.annotations[field])).find((value) => value !== null) ?? null
  return { at: event.date.toISOString(), kind: page ? "page" : "log", name: message, code, traceId: traceOf(event.traceId) }
}

/** A span as the ring reads it when it ends. */
export interface EndedSpan {
  readonly name: string
  readonly kind: string
  readonly attributes: ReadonlyMap<string, unknown>
  readonly failed: boolean
  readonly traceId: string
  readonly date: Date
}

/** The longest request path a record keeps. */
const MAX_PATH = 160

/**
 * The record of an HTTP client span to `/api/` that failed: its method and path (never its query), coded by its status
 * of 400 or more, or `network` when no response came. Nothing for any other span.
 */
export const fromSpan = (span: EndedSpan): ErrorRecord | undefined => {
  const path = span.attributes.get("url.path")
  if (span.kind !== "client" || typeof path !== "string" || !path.startsWith("/api/")) return undefined
  const status = span.attributes.get("http.response.status_code")
  const failed = typeof status === "number" ? status >= 400 : span.failed
  if (!failed) return undefined
  const method = span.attributes.get("http.request.method")
  return {
    at: span.date.toISOString(),
    kind: "http",
    name: `${typeof method === "string" ? method : span.name} ${path.slice(0, MAX_PATH)}`,
    code: typeof status === "number" ? String(status) : "network",
    traceId: traceOf(span.traceId),
  }
}

/** This tab's latest error records. */
export class TabErrors extends Context.Service<
  TabErrors,
  {
    /** Keeps one record; past the ring's size, the oldest goes. */
    readonly record: (record: ErrorRecord) => void
    /** The kept records, newest first. */
    readonly recent: Effect.Effect<ReadonlyArray<ErrorRecord>>
  }
>()("@smthrs/mvp/flows/TabErrors") {
  /** One tab's ring of its latest `kept` records, in memory: a reload forgets it. */
  static readonly ring = (kept: number = ERRORS_KEPT) =>
    Layer.sync(TabErrors, () => {
      const records: Array<ErrorRecord> = []
      return TabErrors.of({
        record: (record) => {
          records.unshift(record)
          if (records.length > kept) records.length = kept
        },
        recent: Effect.sync(() => [...records]),
      })
    })

  /**
   * The ring, fed by a logger merged with the loggers already installed and a tracer wrapping the one installed: each
   * error- or warning-level event named in `records` and each failed `/api/` client span. Build it above the OTLP
   * exporter, so it sees what the exporter sees.
   */
  static readonly observing = (records: ReadonlySet<string>, kept: number = ERRORS_KEPT) =>
    Layer.mergeAll(
      Layer.unwrap(Effect.gen(function* () {
        const errors = yield* TabErrors
        return Logger.layer([
          Logger.make((options) => {
            const formatted = Logger.formatStructured.log(options)
            const record = fromLog({
              message: options.message,
              level: options.logLevel,
              annotations: formatted.annotations,
              traceId: options.fiber.cache.span?.traceId,
              date: options.date,
            }, records)
            if (record !== undefined) errors.record(record)
          }),
        ], { mergeWithExisting: true })
      })),
      Layer.effect(Tracer.Tracer)(
        Effect.gen(function* () {
          const errors = yield* TabErrors
          const tracer = yield* Effect.tracer
          return Tracer.make({
            ...tracer,
            span(options) {
              const span = tracer.span(options)
              const end = span.end.bind(span)
              span.end = (endTime, exit) => {
                end(endTime, exit)
                const record = fromSpan({
                  name: span.name,
                  kind: span.kind,
                  attributes: span.attributes,
                  failed: Exit.isFailure(exit),
                  traceId: span.traceId,
                  date: new Date(),
                })
                if (record !== undefined) errors.record(record)
              }
              return span
            },
          })
        }),
      ),
    ).pipe(Layer.provideMerge(TabErrors.ring(kept)))
}
