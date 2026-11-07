/**
 * Polling sources composed inside a durable flow. Each turn journals its batch,
 * handler receipt and cursor commit separately; waits use the engine's clock.
 *
 * @since 1.0.0
 */

import { Action, DurableClock, FlowRuntime } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import { Failure, fromIntegrationError, toIntegrationError } from "./ActionFailure.ts"
import { CursorStore } from "./CursorStore.ts"
import { ExternalEvent } from "./ExternalEvent.ts"
import { IntegrationError } from "./IntegrationError.ts"

/**
 * One poll turn's result. The cursor is committed only after handling succeeds.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Batch = Schema.Struct({
  events: Schema.Array(ExternalEvent),
  cursor: Schema.optional(Schema.String)
})

/**
 * One poll turn's result.
 *
 * @category models
 * @since 1.0.0
 */
export type Batch = typeof Batch.Type

/**
 * Durable spacing and an optional turn budget. Effect schedules are not durable.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunOptions {
  /** Milliseconds between turns, default 250. Zero skips waiting. */
  readonly intervalMs?: number | undefined
  /** Positive integer turn budget. Omitted means continue until failure or cancellation. */
  readonly maxTurns?: number | undefined
}

/**
 * The context a polling runner requires inside a flow implementation.
 *
 * @category models
 * @since 1.0.0
 */
export type RunContext =
  | CursorStore
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | FlowRuntime.FlowRuntime
  | FlowRuntime.FlowInstance

/**
 * A polling source bound to one cursor. A source must have only one active driver.
 *
 * @category services
 * @since 1.0.0
 */
export interface Source {
  readonly sourceId: string
  /** One poll turn against `cursor`. Commits nothing. */
  readonly poll: (cursor: string | null) => Effect.Effect<Batch, IntegrationError>
  readonly run: <R>(
    onBatch: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, IntegrationError, R>,
    options?: RunOptions | undefined
  ) => Effect.Effect<void, IntegrationError, R | RunContext>
}

/**
 * Polls and handles batches as durable steps inside the current flow execution.
 *
 * Completed polls and handlers replay from receipts. The cursor advances only
 * after the handler succeeds. An interrupted unkeyed handler needs explicit
 * recovery: this helper cannot promise an arbitrary external write is idempotent.
 * Poll and cursor writes are keyed within the execution. The engine owns waits,
 * recovery and observability; no process-local timer or retry loop is installed.
 * Call once per source per execution and provide a persistent CursorStore and
 * durable host in production. Callback failures must be IntegrationErrors so
 * their safe classification can round-trip through the action failure schema.
 *
 * @category constructors
 * @since 1.0.0
 */
export const runWithCursor = <RP, R>(
  sourceId: string,
  poll: (cursor: string | null) => Effect.Effect<Batch, IntegrationError, RP>,
  onBatch: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, IntegrationError, R>,
  options?: RunOptions | undefined
): Effect.Effect<void, IntegrationError, RP | R | RunContext> =>
  Effect.gen(function*() {
    const intervalMs = options?.intervalMs ?? 250
    const maxTurns = options?.maxTurns
    if (
      !Number.isSafeInteger(intervalMs) || intervalMs < 0 ||
      (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1))
    ) {
      return yield* Effect.fail(
        new IntegrationError(
          "invalid-config",
          "Polling requires a nonnegative integer intervalMs and a positive integer maxTurns."
        )
      )
    }
    const instance = yield* FlowRuntime.FlowInstance
    const cursors = yield* CursorStore
    for (let turn = 0; maxTurns === undefined || turn < maxTurns; turn++) {
      const name = `integrations/source/${encodeURIComponent(sourceId)}/${turn}`
      const key = (phase: string) => `${instance.executionId}/${name}/${phase}`
      const batch = yield* Action.make({
        name: `${name}/poll`,
        tier: "irreversible",
        idempotencyKey: key("poll"),
        success: Batch,
        error: Failure,
        execute: Effect.flatMap(cursors.get(sourceId), (cursor) => Effect.suspend(() => poll(cursor))).pipe(
          Effect.mapError(fromIntegrationError)
        )
      }).pipe(Effect.mapError(toIntegrationError))
      yield* Action.make({
        name: `${name}/handle`,
        tier: "irreversible",
        error: Failure,
        execute: Effect.suspend(() => onBatch(batch.events)).pipe(Effect.mapError(fromIntegrationError))
      }).pipe(Effect.mapError(toIntegrationError))
      if (batch.cursor !== undefined) {
        yield* Action.make({
          name: `${name}/commit`,
          tier: "irreversible",
          idempotencyKey: key("commit"),
          error: Failure,
          execute: cursors.set(sourceId, batch.cursor).pipe(Effect.mapError(fromIntegrationError))
        }).pipe(Effect.mapError(toIntegrationError))
      }
      if (maxTurns === undefined || turn + 1 < maxTurns) {
        yield* DurableClock.sleep({ name: `${name}/wait`, duration: intervalMs, inMemoryThreshold: 0 })
      }
    }
  })
