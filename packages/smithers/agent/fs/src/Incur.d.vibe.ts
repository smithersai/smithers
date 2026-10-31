/**
 * Incur projection of executable, model-visible module routes.
 *
 * @since 0.1.0
 */
import { Effect } from "effect";
import type { Cli as IncurCli } from "incur";
import * as FlowInvoker from "./FlowInvoker.vibe";
import { FsError } from "./FsError.vibe";
import * as Route from "./Route.vibe";
export { selfSegment } from "./internal/IncurHost.js";
/**
 * Projects routes onto an Incur CLI while preserving metadata-only discovery.
 *
 * Dispatching one command loads only that command's module. Its actual Effect
 * input schema is then projected into Incur flags and remains the
 * authoritative decoder. A discovery surface must publish those flags, so the
 * first discovery request loads every command module once and reuses the
 * result. Each route has a five-second metadata deadline. Hosts must call
 * `close()` at shutdown to interrupt an active build and release its cache.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare function createCli(name: string, routes: ReadonlyArray<Route.Route>): Effect.Effect<IncurCli.Cli & {
    close: () => Promise<void>;
}, FsError, FlowInvoker.FlowInvoker>;
