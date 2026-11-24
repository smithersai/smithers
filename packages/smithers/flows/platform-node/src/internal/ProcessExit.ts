/**
 * Internal process-exit seam for native signal shutdown handlers.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"

/**
 * Process termination hook used by native signal shutdown escapes.
 * Defaults directly to `process.exit`; tests may provide a recording seam
 * without killing the test worker.
 * @private
 * @since 1.0.0
 */
export const ProcessExit = Context.Reference<(code: number) => void>(
  "@smthrs/platform-node/ProcessExit",
  { defaultValue: () => process.exit }
)
