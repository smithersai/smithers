import { Effect } from "effect"
import { Command } from "../src/index.ts"
export { flowsRoot } from "./agent-command.platform.ts"
/** Lists the commands under root and executes one command string. */
export declare function runAgentCommand(root: string, commandString: string): Effect.Effect<
  {
    listed: readonly Command.ListedCommand[]
    output: unknown
  },
  import("../src/FsError.vibe").FsError,
  never
>
/** Serves one HTTP request and closes its CLI. */
export declare function fetchCommand(
  root: string,
  request: Request
): Effect.Effect<any, import("../src/FsError.vibe").FsError, never>
