/**
 * The random part of a launch reservation id.
 *
 * @since 1.0.0-rc.18
 */

import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

/**
 * Resolves how a store draws the attempt id of a reservation: from the
 * `SecureRandom` service when the composition provides one, so a test that
 * injects a deterministic generator determines every reservation id, and from
 * the platform's `crypto.randomUUID` otherwise. The service is read once, when
 * the store is built, and is optional so a host that composes a store without
 * it keeps working.
 *
 * @private
 * @since 1.0.0-rc.18
 */
export const make: Effect.Effect<Effect.Effect<string>> = Effect.map(
  Effect.serviceOption(SecureRandom.SecureRandom),
  (random) => Option.isSome(random) ? random.value.uuidV4() : Effect.sync(() => globalThis.crypto.randomUUID())
)
