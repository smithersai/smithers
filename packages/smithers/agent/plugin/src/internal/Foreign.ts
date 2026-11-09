/**
 * Foreign dispatcher construction at the Effect boundary.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Plugins from "../Plugins.ts"
import type * as Resolve from "../Resolve.vibe"

/**
 * Defer the foreign dispatcher construction while preserving any thrown defect.
 *
 * @private
 * @since 0.1.0
 */
export const makePlugins = <H>(resolved: Resolve.Resolved<H>): Effect.Effect<Plugins.Service<H>> =>
  Effect.sync(() => Plugins.make<H>(resolved))
