/**
 * Foreign JSON validation at the Effect boundary.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as JsonBoundary from "../JsonBoundary.ts"

/**
 * Defer the foreign JSON check while preserving any thrown defect.
 *
 * @private
 * @since 0.1.0
 */
export const jsonBoundary = (
  value: unknown
): Effect.Effect<ReturnType<typeof JsonBoundary.jsonBoundary>> =>
  Effect.sync(() => JsonBoundary.jsonBoundary(value))
