import { isAbsolute } from "node:path"
import type { NativeOptions } from "./native.ts"

/** The packaging or owning host supplies one explicit executable path. */
export const helperPath = (options: NativeOptions): string => {
  const path = options.helperPath ?? process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  if (path === undefined || !isAbsolute(path)) {
    throw new Error("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY must name the packaged workspace helper")
  }
  return path
}
