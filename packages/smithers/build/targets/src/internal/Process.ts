/**
 * An optional Effect process capability; callers default to the existing host adapter.
 * Keeping this reference internal lets fault services exercise pipe failures
 * while ordinary callers retain the real platform-node lifecycle and cleanup.
 */
import type * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Context from "effect/Context"

export const Process = Context.Reference<Pick<typeof ScopedProcess, "spawn" | "status"> | undefined>(
  "@smthrs/targets/internal/Process",
  { defaultValue: () => undefined }
)
