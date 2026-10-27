/**
 * Optional Effect filesystem for atomic publication. Callers default to real file
 * descriptors; Effect hosts can supply failure-producing implementations.
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as Fs from "node:fs/promises"

/** Optional host filesystem capability; undefined selects native file publication.
 * @since 1.0.0
 * @private
 */
export const PublicationFileSystem = Context.Reference<typeof Fs | undefined>(
  "@smthrs/targets/internal/PublicationFileSystem",
  { defaultValue: () => undefined }
)
