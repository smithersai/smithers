/**
 * Process-launch shape preparation and its failure policy.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import type * as Exec from "../Exec.ts"

/**
 * Existing launcher and diagnostic operations supplied by the host boundary.
 * @since 1.0.0
 * @private
 */
export interface Host {
  readonly shape: typeof Exec.spawnShape
  readonly describe: (cause: unknown) => string
}

/**
 * Maps an unrepresentable launch shape into the caller's spawn refusal.
 * @since 1.0.0
 * @private
 */
export const prepare = <E>(
  host: Host,
  argv: Parameters<typeof Exec.spawnShape>[0],
  options: Parameters<typeof Exec.spawnShape>[1],
  failure: (message: string, code: "spawn_failed") => E
): Effect.Effect<ReturnType<typeof Exec.spawnShape>, E> =>
  Effect.try({
    try: () => host.shape(argv, options),
    catch: (cause) => failure(host.describe(cause), "spawn_failed")
  })
