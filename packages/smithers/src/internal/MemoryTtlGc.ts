/** Expired memory facts, deleted by a durable poll on the host's flow engine.
 *
 * `Maintenance.ttlGc` is one finite pass. The host schedules it as a flow, so
 * the engine owns the wait between passes: the timer is a durable clock, a
 * restarted host joins the lineage it left instead of starting a second one,
 * and nothing about the schedule lives in a forked fiber.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime, Interpreter, Poll, Sleep } from "@smthrs/flow"
import * as Maintenance from "@smthrs/memory/Maintenance"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema, type Scope } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"

/**
 * Time between two passes, in milliseconds.
 * @since 1.0.0
 * @private
 */
export const intervalMs = 600_000

/**
 * The flow one lineage of passes runs under.
 * @since 1.0.0
 * @private
 */
export const flowName = "smithers/memory/TtlGc"

const Pass = Action.make("smithers/memory/TtlGcPass", {
  payload: { attempt: Schema.Number },
  success: Poll.CheckResult(Schema.Number)
})
const TtlGc = Poll.make(flowName, {
  input: {},
  result: Schema.Number,
  intervalMs,
  maxAttempts: Number.MAX_SAFE_INTEGER,
  check: Node.capture(
    { action: Pass.name, implementationVersion: "memory-ttl-gc/v1" },
    ({ attempt }) => Pass.call({ attempt })
  )
})

/**
 * The lineage's execution id, one per build of the poll's plan. A host that
 * starts again under the same build joins the lineage an earlier host left in
 * the engine's store. The engine refuses to resume a lineage under a plan
 * whose callbacks changed, and that refusal is terminal, so a build with
 * another plan runs its own lineage instead of ending this one for good.
 * @since 1.0.0
 * @private
 */
export const executionId = `smithers-memory-ttl-gc-${Node.functionIdentity(TtlGc.body).digest}`

// One store's pass. A pass that fails or dies is logged and counts nothing, so
// the poll still sleeps and runs the next one. A pass the closing host
// interrupts never reaches the handler, so it logs nothing.
const sweep = (store: MemoryStore.Service): Effect.Effect<number> =>
  Maintenance.ttlGc.pipe(
    Effect.provideService(MemoryStore.MemoryStore, store),
    Effect.map(({ deletedFacts }) => deletedFacts),
    Effect.tap((deletedFacts) =>
      deletedFacts > 0 ? Effect.logInfo("memory TTL GC deleted expired facts", { deletedFacts }) : Effect.void
    ),
    Effect.withSpan("Maintenance.ttlGc"),
    Effect.catchCause((cause) => Effect.logWarning("memory TTL GC pass failed", cause).pipe(Effect.as(0)))
  )

/**
 * Starts, or joins, the lineage that deletes the expired facts of `stores`:
 * one pass now, then one every ten minutes, each a round of a durable poll on
 * the host's flow engine.
 *
 * Closing the scope drops the pass's registration. The round parked on its
 * timer stays in the engine's store, and the next host to call this joins it.
 * A host whose engine refuses the lineage logs a warning and keeps starting:
 * expired facts are already hidden from reads.
 *
 * @since 1.0.0
 * @private
 */
export const start = (
  stores: ReadonlyArray<MemoryStore.Service>
): Effect.Effect<
  void,
  never,
  Scope.Scope | FlowRuntime.FlowRuntime | EffectDigest.Digest | SecureRandom.SecureRandom
> =>
  Effect.gen(function*() {
    const registered = yield* Layer.build(Interpreter.layerWithImplementations(
      TtlGc,
      Layer.mergeAll(
        Pass.toLayer(() =>
          Effect.forEach(stores, sweep).pipe(
            Effect.map((deleted) => ({
              satisfied: false,
              output: deleted.reduce((total, count) => total + count, 0)
            }))
          )
        ),
        Poll.layer,
        Sleep.layer
      )
    ))
    yield* TtlGc.execute({}, { executionId, discard: true }).pipe(Effect.provide(registered))
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("memory TTL GC schedule did not start", cause))
  )
