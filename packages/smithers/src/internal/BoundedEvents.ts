/**
 * Bounded collection of durable control-event histories.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import { Effect, Stream } from "effect"
import * as CliError from "../CliError.ts"

/**
 * Largest event count retained by one CLI history projection.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const maximumEvents = 50_000

/**
 * Largest encoded history retained by one CLI projection.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const maximumBytes = 16 * 1024 * 1024

/**
 * Largest encoded individual event admitted to a CLI projection.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const maximumEventBytes = 1024 * 1024

/**
 * Resource limits for one history projection.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Limits {
  readonly maxEvents: number
  readonly maxBytes: number
  readonly maxEventBytes: number
}

/**
 * Stable attribution for one bounded history read.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Context {
  readonly operation: string
  readonly subject: string
}

/**
 * Mutable accumulator owned by one projection.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface HistoryBuffer<A> {
  readonly values: Array<A>
  events: number
  bytes: number
}

/**
 * Default CLI history limits.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const defaultLimits: Limits = {
  maxEvents: maximumEvents,
  maxBytes: maximumBytes,
  maxEventBytes: maximumEventBytes
}

/**
 * Starts an empty bounded accumulator.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const empty = <A>(): HistoryBuffer<A> => ({ values: [], events: 0, bytes: 0 })

/**
 * Encoded bytes charged for one NDJSON-style event.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8") + 1

const exceeded = (
  context: Context,
  limit: number,
  unit: "events" | "bytes"
): CliError.ResourceLimitError => new CliError.ResourceLimitError({ ...context, limit, unit })

/**
 * Folds a stream into an existing budget, failing on the first excess item.
 *
 * Reusing the buffer makes polling incremental: both its cursor payload and
 * its resource accounting advance without rereading or recounting history.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const collectInto = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  buffer: HistoryBuffer<A>,
  context: Context,
  limits: Limits = defaultLimits
): Effect.Effect<HistoryBuffer<A>, E | CliError.ResourceLimitError, R> =>
  Stream.runFoldEffect(
    stream,
    () => buffer,
    (state, value) => {
      const bytes = encodedBytes(value)
      if (bytes > limits.maxEventBytes) return Effect.fail(exceeded(context, limits.maxEventBytes, "bytes"))
      if (state.events >= limits.maxEvents) return Effect.fail(exceeded(context, limits.maxEvents, "events"))
      if (state.bytes + bytes > limits.maxBytes) return Effect.fail(exceeded(context, limits.maxBytes, "bytes"))
      state.values.push(value)
      state.events += 1
      state.bytes += bytes
      return Effect.succeed(state)
    }
  )

/**
 * Collects a stream under a fresh finite event and byte budget.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const collect = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  context: Context,
  limits: Limits = defaultLimits
): Effect.Effect<ReadonlyArray<A>, E | CliError.ResourceLimitError, R> =>
  collectInto(stream, empty<A>(), context, limits).pipe(Effect.map((buffer) => buffer.values))
