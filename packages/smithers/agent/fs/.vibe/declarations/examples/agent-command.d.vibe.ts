import { Effect } from "effect";
import { Command } from "../../../src/index.ts";
/** The flows tree that ships beside this example. */
export { flowsRoot } from "../../../examples/agent-command-root.ts";
/** Lists the agent commands under `root` and executes `commandString`. */
export declare function runAgentCommand(root: string, commandString: string): Effect.Effect<{
    listed: readonly Command.ListedCommand[];
    output: unknown;
}, import("../src/FsError.vibe").FsError, never>;
/** Serves the routes under `root` over HTTP for one request, then closes. */
export declare function fetchCommand(root: string, request: Request): Effect.Effect<unknown, import("../src/FsError.vibe").FsError, never>;
