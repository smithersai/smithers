/**
 * Private lifecycle controls: a hard kill revokes writes without closing the
 * worker scope. Constructing another engine does not revoke a shared-store user.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import type { EngineSubject } from "../EngineSubject.ts"

/**
 * Whether a particular engine instance may still publish writes.
 * @since 1.0.0
 * @category models
 */
export interface EngineOwnerToken {
  active: boolean
}

const owners = new WeakMap<EngineSubject, EngineOwnerToken>()

/**
 * Associates the engine service with its private write token.
 * @since 1.0.0
 * @category constructors
 */
export const registerOwner = (engine: EngineSubject, token: EngineOwnerToken): void => {
  owners.set(engine, token)
}

/**
 * Revokes the MemoryEngine constructed by RestartableEngine without cleanup.
 * @since 1.0.0
 * @category utils
 */
export const revokeOwner = (engine: EngineSubject): Effect.Effect<void> =>
  Effect.sync(() => {
    owners.get(engine)!.active = false
  })
