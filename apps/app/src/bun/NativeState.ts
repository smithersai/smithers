import { homedir } from "node:os"
import { join } from "node:path"

/** Shared by native attachment and the explicit session-owner maintenance command. */
export const nativeStateDirectory = (): string => process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support", "Smithers")
  : join(Bun.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "smithers")
