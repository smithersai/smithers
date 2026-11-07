/**
 * Agent-facing projection of executable, model-visible module routes.
 *
 * @since 0.1.0
 */
import { Effect } from "effect"
import * as FlowInvoker from "./FlowInvoker.vibe"
import { FsError } from "./FsError.vibe"
import * as Route from "./Route.vibe"
/**
 * A route advertised to an agent.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListedCommand {
  name: string
  description: string | undefined
}
/**
 * A decoded command-string invocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface ParsedCommand<A = unknown> {
  route: Route.Route
  argv: ReadonlyArray<string>
  input: A
}
/**
 * Runtime projection of a route manifest for agent use.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSurface {
  /**
   * Lists executable model-visible module routes without loading them.
   * @throws {never}
   */
  list: () => ReadonlyArray<ListedCommand>
  /** Loads the selected module and schema-decodes an agent command string. */
  parse: (commandString: string) => Effect.Effect<ParsedCommand, FsError>
  /** Parses, invokes, and output-encodes an agent command string. */
  execute: (commandString: string) => Effect.Effect<unknown, FsError, FlowInvoker.FlowInvoker>
  /** Validates decoded input and output for an exact named route. */
  call: <N extends Route.Name>(
    name: N,
    input: Route.Input<N>
  ) => Effect.Effect<Route.Output<N>, FsError, FlowInvoker.FlowInvoker>
}
/**
 * Constructs a command surface from routes.
 *
 * Non-module, hidden, and non-model-invocable routes remain available from the
 * registry but never enter this executable projection.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare function make(routes: ReadonlyArray<Route.Route>): Effect.Effect<CommandSurface, FsError>
