import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
/**
 * Stack builders for the control-plane edge suites.
 *
 * `TestControl` fixes one composition; these builders keep the same shape but
 * let a single collaborator be replaced, so a failing journal, a refusing
 * notification queue, a populated registry, or a missing executor can each be
 * observed against the same `ControlLive`.
 */
import type { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Layer } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import type { Control } from "../src/Control.vibe"
import * as ControlExecutor from "../src/ControlExecutor.vibe"
import * as ControlLive from "../src/ControlLive.ts"
import * as ControlRuntime from "../src/ControlRuntime.vibe"
import * as DispatchReader from "../src/DispatchReader.vibe"

/** The same host-free crypto `TestControl` uses, without a Node import. */
export const browserCrypto = Layer.succeed(
  EffectDigest.Digest,
  EffectDigest.Digest.of({
    digest: (algorithm, data) =>
      Effect.promise(() => globalThis.crypto.subtle.digest(algorithm.name, data.slice().buffer)).pipe(
        Effect.map((buffer) => new Uint8Array(buffer))
      ),
    digestHex(algorithm, data) {
      return Effect.map(this.digest(algorithm, data), Hex.encode)
    }
  })
).pipe(Layer.merge(SecureRandom.layerWebCrypto))

/**
 * The deterministic in-memory runtime, already carrying its crypto.
 *
 * @param options the memory runtime's flow catalog, clock, and principal
 */
export const memoryRuntime = (
  options?: ControlRuntime.MemoryOptions
): Layer.Layer<ControlRuntime.ControlRuntime> => ControlRuntime.layerMemory(options).pipe(Layer.provide(browserCrypto))

/**
 * `ControlLive` collaborators a suite may swap.
 *
 * `executor: "absent"` omits the optional acceptance port entirely, which is
 * a different composition from an executor that answers `pending`.
 */
export interface StackOptions {
  readonly runtime?: Layer.Layer<ControlRuntime.ControlRuntime> | undefined
  readonly journal?: Layer.Layer<Journal.Journal> | undefined
  readonly notifications?: Layer.Layer<NotificationQueue.NotificationQueue> | undefined
  readonly registry?: Layer.Layer<Registry.Registry> | undefined
  readonly executor?: ControlExecutor.Service | "absent" | undefined
  /**
   * The trigger read port. Omitted by default, the composition `TestControl`
   * fixes; `"none"` provides `DispatchReader.layerNone` so a suite can tell a
   * declared refusal from an absent port.
   */
  readonly dispatch?: DispatchReader.Service | "none" | undefined
}

/** Everything a control edge test may reach for. */
export type Stack =
  | Control
  | ControlRuntime.ControlRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue

/**
 * Builds a complete `ControlLive` stack from the supplied collaborators.
 *
 * @param options the collaborators to replace; every omitted one is the
 *   deterministic default `TestControl` would have used
 */
export const live = (options: StackOptions = {}): Layer.Layer<Stack> => {
  const journal = options.journal ?? TestJournal.layer()
  const collaborators = Layer.mergeAll(
    options.runtime ?? memoryRuntime(),
    journal,
    options.notifications ?? NotificationQueue.layer.pipe(Layer.provide(journal)),
    options.registry ?? Registry.layerNoop()
  )
  const withExecutor = options.executor === "absent"
    ? collaborators
    : Layer.merge(collaborators, ControlExecutor.layer(options.executor ?? ControlExecutor.makeNoop()))
  const dependencies = options.dispatch === undefined
    ? withExecutor
    : Layer.merge(
      withExecutor,
      options.dispatch === "none" ? DispatchReader.layerNone : DispatchReader.layer(options.dispatch)
    )
  return Layer.provideMerge(ControlLive.layer, dependencies) as Layer.Layer<Stack>
}

/**
 * A registry descriptor as `ControlLive` reads it.
 *
 * The flow listing projects a descriptor onto `{ flowId, description }` and
 * touches nothing else, so the discovery metadata a real scan would carry is
 * deliberately absent.
 *
 * @param name the descriptor's flow name
 * @param description the descriptor's one-line description
 */
export const descriptor = (name: string, description: string): Descriptor.FlowDescriptor =>
  ({ name, description }) as unknown as Descriptor.FlowDescriptor
