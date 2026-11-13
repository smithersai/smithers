/**
 * Host operations for atomic agent-file publication. Fault services retain
 * real temporary writes and cleanup while refusing selected replacements.
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Fs from "node:fs/promises"

/** @private
 * @since 0.1.0
 */
export const filePublicationHostLive = {
  rename: Fs.rename,
  platform: process.platform
}

/** @private
 * @since 0.1.0
 */
export const FilePublicationHost = Context.Reference<typeof filePublicationHostLive>(
  "smithers-build/FilePublicationHost",
  { defaultValue: () => filePublicationHostLive }
)
