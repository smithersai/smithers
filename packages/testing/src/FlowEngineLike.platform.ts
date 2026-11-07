/**
 * `EngineSubject` adapter over the real `/engine`.
 *
 * This is the authoritative subject for the core conformance operations:
 * identity, replay, race, and interruption run against the production engine,
 * not a test-only model. Governing design:
 * `packages/testing/docs/concepts/engine-subject.md`. Smithers capabilities absent from the production
 * contract are recorded as parity gaps rather than simulated. The adapter
 * registers each `FlowSpec` as a real `Flow` whose execute function
 * runs every step as an `Action`:
 *
 * - Sealed steps declare their spec key as the activity idempotency key, so
 *   the engine derives content identity from it and aliased sealed steps
 *   replay one recorded result.
 * - Unsealed steps declare no idempotency key, so the engine derives
 *   occurrence (ordinal) identity and duplicate declared keys run separately.
 * - Race steps run through `Action.raceAll`, the engine's durable race.
 *
 * Step outcomes are journaled by the adapter as they settle; replayed steps
 * never invoke their closures, so the journal is written exactly once per
 * behavior-bearing outcome.
 *
 * @since 0.0.0
 */

// The platform code of FlowEngineLike.vibe, which a .vibe file does not import as a value (EK4402).

import { Crypto } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Web Crypto as the engine's `Crypto`, so `layerMemory` stays a
 * zero-configuration bundle. The engine digests step identities through the
 * service, and `globalThis.crypto` is the one implementation both Node and the
 * browser ship — pulling in a platform package here would cost this package
 * its browser safety.
 */
const layerWebCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, data as BufferSource)),
        (digested) => new Uint8Array(digested)
      )
  })
)

export { layerWebCrypto }
