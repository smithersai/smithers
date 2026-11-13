/**
 * Optional filesystem capability for saved review records and executable identity.
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as NodeFs from "node:fs"

/** Undefined selects native filesystem operations, including native open flags.
 * @since 1.0.0
 * @private
 */
export const ReviewFileSystem = Context.Reference<typeof NodeFs | undefined>(
  "@smthrs/targets/internal/ReviewFileSystem",
  { defaultValue: () => undefined }
)
