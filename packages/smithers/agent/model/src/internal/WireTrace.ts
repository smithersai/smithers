/**
 * Opt-in wire trace for prompt-cache and latency debugging.
 *
 * An injected `WireTrace` sink receives two records per model call, paired
 * by `call`.
 *
 * The `request` line is written as the request is first signed: the route,
 * the cache key and `session-id` header (both public, never the signed
 * credential), whether a remembered affinity token rides along, a short hash
 * of the instructions, a hash and kind for each input item, and how many
 * leading input items match the previous request on the same cache key. A
 * prefix that stops growing while the transcript grows is the signature of a
 * request the provider cannot read back from cache.
 *
 * The `response` line is written when the call ends, however it ends: how it
 * ended, the HTTP status, the wire timing with every failed try, the usage,
 * the response id, the served tier, and the few response headers a provider
 * sends to identify and time a request. No request header is ever written.
 *
 * @since 1.0.0-rc.1
 * @internal
 */

import { Cause, Clock, Effect } from "effect"
import * as CanonicalJson from "../CanonicalJson.ts"
import type { Timing, Usage } from "../ModelEvent.ts"
import type * as Sink from "../WireTrace.ts"

interface Traced {
  readonly routeId: string
  readonly protocolId: string
  readonly publicHeaders: Readonly<Record<string, string>>
  readonly bodyText: string
  readonly body: Uint8Array
  /** Whether the request leaves with a remembered affinity token. */
  readonly affinity?: boolean | undefined
}

interface Body {
  readonly instructions?: unknown
  readonly input?: unknown
  readonly messages?: unknown
  readonly prompt_cache_key?: unknown
}

type Item = { readonly type?: unknown; readonly role?: unknown } | null

const previous = new Map<string, ReadonlyArray<string>>()

/**
 * The trace line for one prepared request; `history` is per process.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const line = (
  prepared: Traced,
  at: number,
  history: Map<string, ReadonlyArray<string>> = previous
): Record<string, unknown> => {
  // Every built-in protocol body is a JSON object; `bodyText` is its serialized form.
  const body = JSON.parse(prepared.bodyText) as Body
  const list = body.input ?? body.messages
  const input: ReadonlyArray<Item> = Array.isArray(list) ? list : []
  const items = input.map((item) => CanonicalJson.shortHash(JSON.stringify(item)))
  const kinds = input.map((item) => String(item?.type ?? item?.role))
  const cacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null
  const slot = cacheKey ?? prepared.routeId
  const before = history.get(slot) ?? []
  let common = 0
  while (common < before.length && before[common] === items[common]) common++
  history.set(slot, items)
  return {
    at: new Date(at).toISOString(),
    kind: "request",
    routeId: prepared.routeId,
    protocolId: prepared.protocolId,
    cacheKey,
    sessionIdHeader: prepared.publicHeaders["session-id"] ?? null,
    affinity: prepared.affinity ?? false,
    instructions: typeof body.instructions === "string" ? CanonicalJson.shortHash(body.instructions) : null,
    bytes: prepared.body.byteLength,
    items,
    kinds,
    commonPrefixItems: common,
    previousItems: before.length
  }
}

/**
 * One call's sink, retained so both records reach the same host.
 * @category models
 * @since 1.0.0
 */
export interface TracedCall {
  readonly id: number
  readonly sink: Sink.WireTrace
}

const append = (sink: Sink.WireTrace, value: Record<string, unknown>): Effect.Effect<void> => {
  const budget = sink.writeTimeoutMs ?? 1_000
  return Effect.suspend(() => sink.write(value)).pipe(
    Effect.timeout(Number.isFinite(budget) && budget > 0 ? budget : 1_000),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)))
        : Effect.logDebug("Model wire trace write failed")
    )
  )
}

/** Numbers traced calls so their two records pair up. */
let calls = 0

/**
 * Records a request only when the host supplied a sink.
 * @category tracing
 * @since 1.0.0
 */
export const record = (
  prepared: Traced,
  sink: Sink.WireTrace | undefined
): Effect.Effect<TracedCall | undefined> =>
  Effect.gen(function*() {
    if (sink === undefined) return undefined
    const id = ++calls
    const { at, kind, ...request } = line(prepared, yield* Clock.currentTimeMillis)
    return yield* Effect.as(append(sink, { at, kind, call: id, ...request }), { id, sink })
  })

/**
 * What one call's response line is written from. Everything here is what the
 * provider answered or how long it took; nothing here is what was signed.
 *
 * @category models
 * @since 1.0.0
 */
export interface Answered {
  readonly routeId: string
  readonly protocolId: string
  /**
   * How the call ended: `settled` with a stop reason, `ended` when the stream
   * finished without one, `interrupted` when its fiber was, or the code of the
   * failure that ended it.
   */
  readonly outcome: string
  readonly stopReason?: string | undefined
  /** The answered response's HTTP status, or the last failed try's. */
  readonly status?: number | undefined
  readonly timing: Timing
  readonly usage: Usage
  readonly responseId?: string | undefined
  readonly servedTier?: string | undefined
  /** The answered response's headers; only {@link reportedHeaders} are kept. */
  readonly headers?: Readonly<Record<string, string>> | undefined
}

/**
 * The response headers a provider sends to identify a request and to say how
 * long its own side took. They are copied by name; no other header is read,
 * so a cookie or a routing token never reaches the trace.
 *
 * @category constants
 * @since 1.0.0
 */
export const reportedHeaders: ReadonlyArray<string> = [
  "x-request-id",
  "request-id",
  "cf-ray",
  "openai-processing-ms",
  "x-envoy-upstream-service-time"
]

/**
 * The trace line for one call's response.
 *
 * @category models
 * @since 1.0.0
 */
export const responseLine = (call: number, answered: Answered, at: number): Record<string, unknown> => ({
  at: new Date(at).toISOString(),
  kind: "response",
  call,
  routeId: answered.routeId,
  protocolId: answered.protocolId,
  outcome: answered.outcome,
  stopReason: answered.stopReason ?? null,
  status: answered.status ?? null,
  responseId: answered.responseId ?? null,
  servedTier: answered.servedTier ?? null,
  timing: answered.timing,
  usage: answered.usage,
  headers: Object.fromEntries(
    reportedHeaders.flatMap((name) => {
      const value = answered.headers?.[name]
      return value === undefined ? [] : [[name, value]]
    })
  )
})

/**
 * Records a response on the sink that received the request, if any.
 * @category tracing
 * @since 1.0.0
 */
export const recordResponse = (
  call: TracedCall | undefined,
  answered: () => Answered,
  at: number
): Effect.Effect<void> =>
  Effect.suspend(() => call === undefined ? Effect.void : append(call.sink, responseLine(call.id, answered(), at)))
