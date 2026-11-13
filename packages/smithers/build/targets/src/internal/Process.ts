/**
 * An optional Effect process capability; callers default to the existing host adapter.
 * Keeping this reference internal lets fault services exercise pipe failures
 * while ordinary callers retain the real platform-node lifecycle and cleanup.
 * @since 1.0.0
 */

import type * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Context from "effect/Context"

/** Optional host process capability; undefined selects the native adapter.
 * @since 1.0.0
 * @private
 */
export const Process = Context.Reference<
  | (Pick<typeof ScopedProcess, "spawn" | "status"> & {
    /** Platform used only to select a module launcher; execution keeps the native host lifecycle. */
    readonly platform?: NodeJS.Platform
  })
  | undefined
>(
  "@smthrs/targets/internal/Process",
  { defaultValue: () => undefined }
)
