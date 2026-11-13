/**
 * Compatibility policy for destination-restricted execution.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import type * as Exec from "../Exec.ts"

/**
 * The confinement facts used by the destination restriction.
 * @since 1.0.0
 * @private
 */
export interface Confinement {
  readonly mechanism: { readonly _tag: string }
  readonly network: string
}

/**
 * Destination allowlists require the closed-network native Linux launcher and no proxy secrets.
 * @since 1.0.0
 * @private
 */
export const refused = (
  destinations: unknown,
  confinement: Confinement | undefined,
  secrets: number
): boolean =>
  destinations !== undefined && (
    confinement === undefined || confinement.mechanism._tag !== "bubblewrap" ||
    confinement.network !== "none" || secrets > 0
  )

/**
 * Refuses incompatible destination enforcement before secret proxy or child startup.
 * @since 1.0.0
 * @private
 */
export const validate = (
  destinations: unknown,
  confinement: Confinement | undefined,
  secrets: number,
  argv: Exec.Payload["argv"],
  cwd: string
): Effect.Effect<void, Exec.ExecError> =>
  refused(destinations, confinement, secrets)
    ? Effect.fail({
      _tag: "smithers-build/ExecError",
      argv,
      cwd,
      exitCode: -1,
      code: "sandbox_unenforceable",
      stdout: "",
      stderr: "sandbox: destination allowlists require bubblewrap with a closed network and no secret proxy"
    })
    : Effect.void
