/**
 * Deterministic in-memory Control stack for package and consumer tests.
 *
 * @since 0.1.0
 */

import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Layer } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as ControlExecutor from "../ControlExecutor.ts"
import * as ControlLive from "../ControlLive.ts"
import * as ControlRuntime from "../ControlRuntime.ts"

const browserCrypto = Layer.merge(EffectDigest.layerWebCrypto, SecureRandom.layerWebCrypto)

/**
 * Provides Control, ControlRuntime, the in-memory journal bundle, and an empty
 * registry. Runtime flow metadata falls back to the reserved system catalog.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options?: ControlRuntime.MemoryOptions,
  executor: ControlExecutor.Service = ControlExecutor.makeNoop()
) => {
  const journal = TestJournal.layer()
  const dependencies = Layer.mergeAll(
    ControlRuntime.layerMemory(options).pipe(Layer.provide(browserCrypto)),
    journal,
    NotificationQueue.layer.pipe(Layer.provide(journal)),
    ControlExecutor.layer(executor),
    Registry.layerNoop()
  )
  return Layer.provideMerge(ControlLive.layer, dependencies)
}
