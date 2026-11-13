/**
 * Optional host facts for execution confinement; ordinary runs use the native host.
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type { Host } from "../ExecSandbox.ts"

/** Host facts shared by sandbox planning, write validation and command rendering.
 * @since 1.0.0
 * @private
 */
export const SandboxHost = Context.Reference<Host | undefined>(
  "@smthrs/targets/internal/SandboxHost",
  { defaultValue: () => undefined }
)
