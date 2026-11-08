/**
 * The stopwatch of one model call.
 *
 * A route starts one when a call starts and marks each stage as it passes;
 * the reading is the `ModelEvent.Timing` the call's settle event carries. It
 * reads Effect's `Clock`, so a test clock controls every value, and it reads
 * it through the clock's synchronous accessor: a call emits thousands of
 * deltas, and the last one is only known to be the last after the fact, so
 * each is timed as it passes.
 *
 * A stage that was never marked is absent from the reading. Nothing here
 * estimates one.
 *
 * @since 1.0.0
 * @internal
 */

import type * as Clock from "effect/Clock"
import type { FailedTry, ModelEvent, Timing } from "../ModelEvent.ts"
import type * as RequestExecutor from "../RequestExecutor.ts"

/**
 * One call's stopwatch: a mark per stage, and the reading so far.
 *
 * @category models
 * @since 1.0.0
 */
export interface CallTiming {
  /** The request was validated and encoded to the bytes that are sent. */
  readonly prepared: (requestBytes: number) => void
  /** The credential was resolved and the request signed. */
  readonly signed: () => void
  /** An HTTP try left, or failed; see `RequestExecutor.TryEvent`. */
  readonly onTry: (event: RequestExecutor.TryEvent) => void
  /** The response status and headers arrived. */
  readonly headers: () => void
  /** A framed provider event arrived. */
  readonly frame: () => void
  /** A normalized event left the protocol. */
  readonly event: (event: ModelEvent) => void
  /** The response stream closed; the first mark stands. */
  readonly closed: () => void
  /** What has been marked so far. */
  readonly read: () => Timing
}

/**
 * Starts the stopwatch: `clock` now is the instant every offset counts from.
 *
 * @category constructors
 * @since 1.0.0
 */
export const start = (clock: Clock.Clock): CallTiming => {
  const startedAt = clock.currentTimeMillisUnsafe()
  // Whole milliseconds: a jittered retry wait leaves a test clock on a fraction.
  const since = (at: number): number => Math.round(at - startedAt)
  const now = (): number => since(clock.currentTimeMillisUnsafe())
  const failedTries: Array<FailedTry> = []
  let attempts = 0
  let requestBytes: number | undefined
  let preparedMs: number | undefined
  let signedMs: number | undefined
  let sentMs: number | undefined
  let headersMs: number | undefined
  let firstEventMs: number | undefined
  let firstThinkingMs: number | undefined
  let firstOutputMs: number | undefined
  let lastOutputMs: number | undefined
  let completedMs: number | undefined
  let closedMs: number | undefined
  return {
    prepared: (bytes) => {
      requestBytes = bytes
      preparedMs = now()
    },
    signed: () => {
      signedMs = now()
    },
    onTry: (event) => {
      if (event.type === "sent") {
        attempts += 1
        sentMs = since(event.at)
        return
      }
      failedTries.push({
        sentMs: since(event.sentAt),
        failedMs: since(event.at),
        code: event.code,
        ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus })
      })
    },
    headers: () => {
      headersMs = now()
    },
    frame: () => {
      firstEventMs ??= now()
    },
    event: (event) => {
      switch (event.type) {
        case "thinking-start":
        case "thinking-delta":
          firstThinkingMs ??= now()
          return
        case "text-delta":
        case "tool-call-delta":
          lastOutputMs = now()
          firstOutputMs ??= lastOutputMs
          return
        case "settle":
          completedMs ??= now()
          return
      }
    },
    closed: () => {
      closedMs ??= now()
    },
    read: () =>
      Object.fromEntries(
        Object.entries({
          startedAt,
          attempts: attempts === 0 ? undefined : attempts,
          requestBytes,
          preparedMs,
          signedMs,
          sentMs,
          headersMs,
          firstEventMs,
          firstThinkingMs,
          firstOutputMs,
          lastOutputMs,
          completedMs,
          closedMs,
          failedTries: failedTries.length === 0 ? undefined : [...failedTries]
        }).filter(([, value]) => value !== undefined)
      )
  }
}

const snake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/**
 * A reading as span attributes, `smithers.model.<stage>` in snake case:
 * `smithers.model.headers_ms`, `smithers.model.first_output_ms`. The failed
 * tries are their codes in order, `smithers.model.failed_tries`. The start
 * instant is left out: a span has its own.
 *
 * @category conversions
 * @since 1.0.0
 */
export const attributes = (timing: Timing): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(timing).flatMap(([name, value]): ReadonlyArray<readonly [string, unknown]> =>
      name === "startedAt"
        ? []
        : [[
          `smithers.model.${snake(name)}`,
          name === "failedTries" ? (value as ReadonlyArray<FailedTry>).map((failed) => failed.code) : value
        ]]
    )
  )
