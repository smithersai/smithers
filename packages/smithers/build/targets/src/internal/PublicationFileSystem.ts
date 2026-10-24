/**
 * Optional Effect filesystem for atomic publication. Callers default to real file
 * descriptors; Effect hosts can supply failure-producing implementations.
 */
import * as Context from "effect/Context"
import type * as Fs from "node:fs/promises"

export const PublicationFileSystem = Context.Reference<typeof Fs | undefined>(
  "@smthrs/targets/internal/PublicationFileSystem",
  { defaultValue: () => undefined }
)
