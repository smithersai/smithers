import { fileURLToPath } from "node:url"
import type { Server } from "../examples/vibelang/quickstart.vibe"

/** The page's server, started by this Node; VibeLang code reads no Node globals. */
export const server: Server = {
  command: process.execPath,
  args: [fileURLToPath(new URL("../examples/quickstart-server.mjs", import.meta.url))]
}
