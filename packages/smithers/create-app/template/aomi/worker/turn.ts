/**
 * The turn entry the Durable Object calls. It defers loading the agent
 * runtime (`./turnImpl.ts` and everything under `@smthrs/*`) until the first
 * request: Cloudflare rejects a Worker whose module scope performs I/O, and
 * the runtime seeds identities at load. The lazy import also keeps the DO
 * cold start small.
 *
 * The load is awaited before the caller gets anything back, so the caller
 * holds the implementation's own stream: a hangup cancels it directly, and a
 * refusal arrives as a value the caller answers with JSON.
 */
export type { TurnOptions, TurnSession } from "./turnImpl.ts"
import type { TurnRefusal } from "@smthrs/create-app/worker"
import type { TurnOptions } from "./turnImpl.ts"

/** What a turn is: its NDJSON stream, or the refusal decided before one opened. */
export type TurnResult = ReadableStream<Uint8Array> | TurnRefusal

/**
 * Loads the turn implementation.
 *
 * Injectable for the same reason `RoutesBinOptions.write` and
 * `CachedModelTestOptions.routes` are: this wrapper's contract is forwarding,
 * and proving that must not require the agent runtime, the tools directory, or
 * QuickJS.
 */
export type TurnLoader = () => Promise<{
  readonly runTurn: (options: TurnOptions) => Promise<TurnResult>
}>

export const runTurn = async (
  options: TurnOptions,
  load: TurnLoader = () => import("./turnImpl.ts")
): Promise<TurnResult> => {
  const { runTurn: run } = await load()
  return run(options)
}
